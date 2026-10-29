import type { RecipeCtx, RecipeEventInput, RecipeRuntime } from '@core/types';
import { performOnJava } from '@runtime/java-bridge';
import { getJavaClass } from '@runtime/java-utils';
import { meta } from './focused-runtime.meta';
import { androidApi } from '@modules/android-runtime-bypass/api-runtime';
import type { ApiObservation } from '@modules/android-runtime-bypass/api-hooks';

type RecipeEventKind = RecipeEventInput['kind'];
type RecipeEventPhase = NonNullable<RecipeEventInput['phase']>;
type RecipeEventTarget = NonNullable<RecipeEventInput['target']>;
type RecipeEventContext = NonNullable<RecipeEventInput['context']>;

function stringify(value: unknown): string {
  try {
    if (value === null || value === undefined) {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map(item => stringify(item)).join(' ');
    }
    if (typeof value === 'object' && '$className' in (value as Record<string, unknown>)) {
      return String((value as Record<string, unknown>).$className);
    }
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

function truncate(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function flagEnabled(ctx: RecipeCtx, key: string): boolean {
  return ctx.recipe.flags[key] === true;
}

function eventLimiter() {
  const counts = new Map<string, number>();
  return (point: string, phase: RecipeEventPhase, max: number) => {
    const key = `${point}:${phase}`;
    const next = (counts.get(key) || 0) + 1;
    counts.set(key, next);
    return next <= max;
  };
}

function buildTarget(className: string, methodName: string, signature: string): RecipeEventTarget {
  return {
    className,
    methodName,
    signature,
  };
}

function buildContext(stage: string): RecipeEventContext {
  const runtimeProcess = (
    globalThis as {
      Process?: {
        id?: number;
        getCurrentThreadId?: () => number;
      };
    }
  ).Process;

  return {
    processId: runtimeProcess?.id,
    threadId: runtimeProcess?.getCurrentThreadId?.(),
    layer: 'java',
    stage,
  };
}

function emitRecipeEvent(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean,
  event: RecipeEventInput & {
    point: string;
    kind: RecipeEventKind;
    phase?: RecipeEventPhase;
    max?: number;
  }
) {
  const phase = event.phase ?? 'instant';
  const max = event.max ?? 80;
  if (!allowEvent(event.point, phase, max)) {
    return;
  }

  ctx.recipe.emit({
    ...event,
    phase,
  });
}

function emitRecipeError(
  ctx: RecipeCtx,
  point: string,
  stage: string,
  code: string,
  message: string,
  target?: RecipeEventTarget,
  attrs?: Record<string, unknown>
) {
  ctx.recipe.emit({
    point,
    kind: 'error',
    phase: 'instant',
    target,
    context: buildContext(stage),
    attrs,
    error: {
      code,
      message,
    },
  });
}

let releaseRootObservation: (() => Promise<void>) | undefined;
async function installRootSignalHooks(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean
) {
  const lease = await androidApi.acquire();
  const unsubscribe = lease.owner.subscribe(
    (event: ApiObservation) => {
      const args = event.args as any;
      let point: string;
      let target: RecipeEventTarget;
      let attrs: Record<string, unknown>;
      const phase = event.phase ?? 'leave';
      if (
        (event.api.startsWith('Runtime.exec') || event.api === 'ProcessBuilder.start') &&
        /su|busybox|getprop|mount|magisk|xposed|frida|emui|letv|root/i.test(
          (args.argv ?? []).join(' ')
        )
      ) {
        const builder = event.api === 'ProcessBuilder.start';
        point = builder ? 'root/process-builder/start' : 'root/command/exec';
        target = buildTarget(
          builder ? 'java.lang.ProcessBuilder' : 'java.lang.Runtime',
          builder ? 'start' : 'exec',
          builder ? '()' : event.api.includes('[L') ? '(java.lang.String[])' : '(java.lang.String)'
        );
        attrs = {
          command: truncate(args.argv.join(' ')),
          ...(builder ? {} : { commandType: event.api.includes('[L') ? 'array' : 'string' }),
          resultClass: 'java.lang.Process',
        };
      } else if (
        event.api === 'java.io.File.exists' &&
        /\/su$|busybox|magisk|xposed|frida|Superuser\.apk|\/proc\/self\/maps|\/proc\/self\/status/i.test(
          args.path
        )
      ) {
        point = 'root/file/exists';
        target = buildTarget('java.io.File', 'exists', '()');
        attrs = { path: args.path, exists: event.result };
      } else if (
        event.api.startsWith('SystemProperties.get') &&
        /ro\.build\.tags|ro\.debuggable|ro\.secure|ro\.product|ro\.hardware|ro\.kernel|qemu|emui|letv|miui|oppo|vivo/i.test(
          args.key
        )
      ) {
        point = 'system/property/get';
        target = buildTarget(
          'android.os.SystemProperties',
          'get',
          event.api.endsWith('(2)') ? '(java.lang.String,java.lang.String)' : '(java.lang.String)'
        );
        attrs = {
          name: args.key,
          result: event.result,
          ...(args.defaultValue === undefined ? {} : { defaultValue: args.defaultValue }),
        };
      } else {
        return;
      }
      emitRecipeEvent(ctx, allowEvent, {
        point,
        kind: event.error ? 'error' : 'probe',
        phase,
        target,
        context: buildContext('root-signal'),
        attrs: {
          ...attrs,
          observedAfterCall: phase === 'leave',
          ...(event.error ? { error: event.error } : {}),
        },
        max: 160,
      });
    },
    { enter: true }
  );
  releaseRootObservation = async () => {
    unsubscribe();
    await lease.release();
  };
}

function installDeviceIdentityHooks(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean
) {
  try {
    const TelephonyManager = getJavaClass('android.telephony.TelephonyManager', true);
    [
      'getDeviceId',
      'getImei',
      'getMeid',
      'getSubscriberId',
      'getSimSerialNumber',
      'getLine1Number',
      'getSimOperator',
      'getSimOperatorName',
      'getNetworkOperator',
      'getNetworkOperatorName',
      'getSimCountryIso',
      'getNetworkCountryIso',
    ].forEach(methodName => {
      try {
        const overload = TelephonyManager[methodName].overload();
        overload.implementation = function () {
          const result = overload.call(this);
          emitRecipeEvent(ctx, allowEvent, {
            point: 'device/telephony/read',
            kind: 'probe',
            phase: 'leave',
            target: buildTarget('android.telephony.TelephonyManager', methodName, '()'),
            context: buildContext('device-identity'),
            attrs: {
              method: methodName,
              value: stringify(result),
            },
            max: 80,
          });
          return result;
        };
      } catch (e) {
        ctx.recipe.log('Telephony hook skipped for %s: %s', methodName, e);
        emitRecipeError(
          ctx,
          'device/telephony/read',
          'device-identity',
          'HOOK_INSTALL_FAILED',
          stringify(e),
          buildTarget('android.telephony.TelephonyManager', methodName, '()')
        );
      }
    });
  } catch (e) {
    ctx.recipe.log('Device identity hook TelephonyManager failed: %s', e);
    emitRecipeError(
      ctx,
      'device/telephony/read',
      'device-identity',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget('android.telephony.TelephonyManager', '*', '()')
    );
  }

  try {
    const SettingsSecure = getJavaClass('android.provider.Settings$Secure', true);
    const getString = SettingsSecure.getString.overload(
      'android.content.ContentResolver',
      'java.lang.String'
    );
    getString.implementation = function (resolver: unknown, name: string) {
      const settingName = String(name);
      if (settingName.toLowerCase().includes('android_id')) {
        emitRecipeEvent(ctx, allowEvent, {
          point: 'device/android-id/read',
          kind: 'probe',
          phase: 'enter',
          target: buildTarget(
            'android.provider.Settings$Secure',
            'getString',
            '(android.content.ContentResolver,java.lang.String)'
          ),
          context: buildContext('device-identity'),
          attrs: {
            name: settingName,
          },
          max: 40,
        });
      }
      const result = getString.call(this, resolver, name);
      if (settingName.toLowerCase().includes('android_id')) {
        emitRecipeEvent(ctx, allowEvent, {
          point: 'device/android-id/read',
          kind: 'probe',
          phase: 'leave',
          target: buildTarget(
            'android.provider.Settings$Secure',
            'getString',
            '(android.content.ContentResolver,java.lang.String)'
          ),
          context: buildContext('device-identity'),
          attrs: {
            name: settingName,
            value: stringify(result),
          },
          max: 40,
        });
      }
      return result;
    };
  } catch (e) {
    ctx.recipe.log('Device identity hook Settings.Secure.getString failed: %s', e);
    emitRecipeError(
      ctx,
      'device/android-id/read',
      'device-identity',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget(
        'android.provider.Settings$Secure',
        'getString',
        '(android.content.ContentResolver,java.lang.String)'
      )
    );
  }
}

function installWebViewBridgeHooks(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean
) {
  try {
    const WebView = getJavaClass('android.webkit.WebView', true);
    const addJavascriptInterface = WebView.addJavascriptInterface.overload(
      'java.lang.Object',
      'java.lang.String'
    );
    addJavascriptInterface.implementation = function (obj: unknown, name: string) {
      emitRecipeEvent(ctx, allowEvent, {
        point: 'webview/interface/add',
        kind: 'trace',
        phase: 'enter',
        target: buildTarget(
          'android.webkit.WebView',
          'addJavascriptInterface',
          '(java.lang.Object,java.lang.String)'
        ),
        context: buildContext('webview'),
        attrs: {
          interfaceName: stringify(name),
          objectClass: stringify(obj),
        },
        max: 120,
      });
      return addJavascriptInterface.call(this, obj, name);
    };

    const evaluateJavascript = WebView.evaluateJavascript.overload(
      'java.lang.String',
      'android.webkit.ValueCallback'
    );
    evaluateJavascript.implementation = function (script: string, callback: unknown) {
      emitRecipeEvent(ctx, allowEvent, {
        point: 'webview/javascript/evaluate',
        kind: 'trace',
        phase: 'enter',
        target: buildTarget(
          'android.webkit.WebView',
          'evaluateJavascript',
          '(java.lang.String,android.webkit.ValueCallback)'
        ),
        context: buildContext('webview'),
        attrs: {
          scriptPreview: truncate(stringify(script)),
          hasCallback: callback !== null && callback !== undefined,
        },
        max: 120,
      });
      return evaluateJavascript.call(this, script, callback);
    };

    const loadUrl = WebView.loadUrl.overload('java.lang.String');
    loadUrl.implementation = function (url: string) {
      const text = stringify(url);
      if (/^javascript:/i.test(text) || /bridge|callback|jsb|xbridge/i.test(text)) {
        emitRecipeEvent(ctx, allowEvent, {
          point: 'webview/javascript/load-url',
          kind: 'trace',
          phase: 'enter',
          target: buildTarget('android.webkit.WebView', 'loadUrl', '(java.lang.String)'),
          context: buildContext('webview'),
          attrs: {
            urlPreview: truncate(text),
          },
          max: 120,
        });
      }
      return loadUrl.call(this, url);
    };
  } catch (e) {
    ctx.recipe.log('WebView bridge hook failed: %s', e);
    emitRecipeError(
      ctx,
      'webview/interface/add',
      'webview',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget('android.webkit.WebView', '*', '(...)')
    );
  }
}

function installDynamicLoadingHooks(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean
) {
  try {
    const DexClassLoader = getJavaClass('dalvik.system.DexClassLoader', true);
    const init = DexClassLoader.$init.overload(
      'java.lang.String',
      'java.lang.String',
      'java.lang.String',
      'java.lang.ClassLoader'
    );
    init.implementation = function (
      dexPath: string,
      optimizedDirectory: string,
      librarySearchPath: string,
      parent: unknown
    ) {
      emitRecipeEvent(ctx, allowEvent, {
        point: 'dynamic/dex-class-loader/init',
        kind: 'trace',
        phase: 'enter',
        target: buildTarget(
          'dalvik.system.DexClassLoader',
          '<init>',
          '(java.lang.String,java.lang.String,java.lang.String,java.lang.ClassLoader)'
        ),
        context: buildContext('dynamic-loading'),
        attrs: {
          dexPath: stringify(dexPath),
          optimizedDirectory: stringify(optimizedDirectory),
          librarySearchPath: stringify(librarySearchPath),
          parentClass: stringify(parent),
        },
        max: 80,
      });
      return init.call(this, dexPath, optimizedDirectory, librarySearchPath, parent);
    };
  } catch (e) {
    ctx.recipe.log('Dynamic loading hook DexClassLoader failed: %s', e);
    emitRecipeError(
      ctx,
      'dynamic/dex-class-loader/init',
      'dynamic-loading',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget(
        'dalvik.system.DexClassLoader',
        '<init>',
        '(java.lang.String,java.lang.String,java.lang.String,java.lang.ClassLoader)'
      )
    );
  }

  try {
    const DexFile = getJavaClass('dalvik.system.DexFile', true);
    const loadDex = DexFile.loadDex.overload('java.lang.String', 'java.lang.String', 'int');
    loadDex.implementation = function (
      sourcePathName: string,
      outputPathName: string,
      flags: number
    ) {
      emitRecipeEvent(ctx, allowEvent, {
        point: 'dynamic/dex-file/load',
        kind: 'trace',
        phase: 'enter',
        target: buildTarget(
          'dalvik.system.DexFile',
          'loadDex',
          '(java.lang.String,java.lang.String,int)'
        ),
        context: buildContext('dynamic-loading'),
        attrs: {
          sourcePathName: stringify(sourcePathName),
          outputPathName: stringify(outputPathName),
          flags: Number(flags),
        },
        max: 80,
      });
      return loadDex.call(this, sourcePathName, outputPathName, flags);
    };
  } catch (e) {
    ctx.recipe.log('Dynamic loading hook DexFile.loadDex failed: %s', e);
    emitRecipeError(
      ctx,
      'dynamic/dex-file/load',
      'dynamic-loading',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget('dalvik.system.DexFile', 'loadDex', '(java.lang.String,java.lang.String,int)')
    );
  }
}

function installReflectionHooks(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean
) {
  const interestingClass = (className: string) =>
    /^X\.|^com\.bytedance\.|^com\.ss\.|^com\.appsflyer\.|^ms\.bd\.|dynamite|zoin|DexClassLoader|PathClassLoader/i.test(
      className
    );

  try {
    const Class = getJavaClass('java.lang.Class', true);
    const forName = Class.forName.overload('java.lang.String');
    forName.implementation = function (className: string) {
      const text = stringify(className);
      if (interestingClass(text)) {
        emitRecipeEvent(ctx, allowEvent, {
          point: 'reflection/class/for-name',
          kind: 'trace',
          phase: 'enter',
          target: buildTarget('java.lang.Class', 'forName', '(java.lang.String)'),
          context: buildContext('reflection'),
          attrs: {
            requestedClassName: text,
          },
          max: 120,
        });
      }
      const result = forName.call(this, className);
      if (interestingClass(text)) {
        emitRecipeEvent(ctx, allowEvent, {
          point: 'reflection/class/for-name',
          kind: 'trace',
          phase: 'leave',
          target: buildTarget('java.lang.Class', 'forName', '(java.lang.String)'),
          context: buildContext('reflection'),
          attrs: {
            requestedClassName: text,
            resolvedClassName: stringify(result),
          },
          max: 120,
        });
      }
      return result;
    };
  } catch (e) {
    ctx.recipe.log('Reflection hook Class.forName failed: %s', e);
    emitRecipeError(
      ctx,
      'reflection/class/for-name',
      'reflection',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget('java.lang.Class', 'forName', '(java.lang.String)')
    );
  }
}

function installCryptoHooks(
  ctx: RecipeCtx,
  allowEvent: (_point: string, _phase: RecipeEventPhase, _max: number) => boolean
) {
  try {
    const Cipher = getJavaClass('javax.crypto.Cipher', true);
    const getInstance = Cipher.getInstance.overload('java.lang.String');
    getInstance.implementation = function (transformation: string) {
      const text = stringify(transformation);
      emitRecipeEvent(ctx, allowEvent, {
        point: 'crypto/cipher/get-instance',
        kind: 'trace',
        phase: 'enter',
        target: buildTarget('javax.crypto.Cipher', 'getInstance', '(java.lang.String)'),
        context: buildContext('crypto'),
        attrs: {
          transformation: text,
        },
        max: 80,
      });
      const result = getInstance.call(this, transformation);
      emitRecipeEvent(ctx, allowEvent, {
        point: 'crypto/cipher/get-instance',
        kind: 'trace',
        phase: 'leave',
        target: buildTarget('javax.crypto.Cipher', 'getInstance', '(java.lang.String)'),
        context: buildContext('crypto'),
        attrs: {
          transformation: text,
          resultClass: stringify(result),
        },
        max: 80,
      });
      return result;
    };
  } catch (e) {
    ctx.recipe.log('Crypto hook Cipher.getInstance failed: %s', e);
    emitRecipeError(
      ctx,
      'crypto/cipher/get-instance',
      'crypto',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget('javax.crypto.Cipher', 'getInstance', '(java.lang.String)')
    );
  }

  try {
    const MessageDigest = getJavaClass('java.security.MessageDigest', true);
    const getInstance = MessageDigest.getInstance.overload('java.lang.String');
    getInstance.implementation = function (algorithm: string) {
      const text = stringify(algorithm);
      emitRecipeEvent(ctx, allowEvent, {
        point: 'crypto/digest/get-instance',
        kind: 'trace',
        phase: 'enter',
        target: buildTarget('java.security.MessageDigest', 'getInstance', '(java.lang.String)'),
        context: buildContext('crypto'),
        attrs: {
          algorithm: text,
        },
        max: 80,
      });
      const result = getInstance.call(this, algorithm);
      emitRecipeEvent(ctx, allowEvent, {
        point: 'crypto/digest/get-instance',
        kind: 'trace',
        phase: 'leave',
        target: buildTarget('java.security.MessageDigest', 'getInstance', '(java.lang.String)'),
        context: buildContext('crypto'),
        attrs: {
          algorithm: text,
          resultClass: stringify(result),
        },
        max: 80,
      });
      return result;
    };
  } catch (e) {
    ctx.recipe.log('Crypto hook MessageDigest.getInstance failed: %s', e);
    emitRecipeError(
      ctx,
      'crypto/digest/get-instance',
      'crypto',
      'HOOK_INSTALL_FAILED',
      stringify(e),
      buildTarget('java.security.MessageDigest', 'getInstance', '(java.lang.String)')
    );
  }
}

async function activate(ctx: RecipeCtx) {
  const { env } = ctx;

  if (env.platform !== 'android' || !env.javaAvailable) {
    ctx.recipe.log('Focused runtime audit skipped: not Android or Java not available');
    return;
  }

  const allowEvent = eventLimiter();
  ctx.recipe.log('Activating focused Android runtime audit recipe');
  ctx.recipe.emit({
    point: 'recipe-start',
    kind: 'validate',
    phase: 'instant',
    context: buildContext('recipe-lifecycle'),
    attrs: {
      enabledFlags: Object.keys(ctx.recipe.flags).sort(),
      targetAppId: env.appId || 'unknown',
    },
  });

  if (flagEnabled(ctx, 'audit.rootSignals')) {
    await installRootSignalHooks(ctx, allowEvent);
  }
  await performOnJava(() => {
    if (flagEnabled(ctx, 'audit.deviceId')) {
      installDeviceIdentityHooks(ctx, allowEvent);
    }
    if (flagEnabled(ctx, 'audit.webviewBridge')) {
      installWebViewBridgeHooks(ctx, allowEvent);
    }
    if (flagEnabled(ctx, 'audit.dynamicLoad')) {
      installDynamicLoadingHooks(ctx, allowEvent);
    }
    if (flagEnabled(ctx, 'audit.reflection')) {
      installReflectionHooks(ctx, allowEvent);
    }
    if (flagEnabled(ctx, 'audit.crypto')) {
      installCryptoHooks(ctx, allowEvent);
    }
  });

  ctx.recipe.log('Focused Android runtime audit recipe activated');
}

export const runtime: RecipeRuntime = {
  ...meta,
  activate,
  async deactivate() {
    if (releaseRootObservation) {
      await releaseRootObservation();
      releaseRootObservation = undefined;
    }
  },
};
