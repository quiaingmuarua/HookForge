import { Env, Platform } from '@core/types';
import { isJavaAvailable, performOnJava, Java } from './java-bridge';

function coerceString(value: any): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  try {
    const raw = value?.value ?? value;
    const text = raw?.toString?.() ?? String(raw);
    return text && text !== 'null' && text !== 'undefined' ? text : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeAndroidPackage(value?: string): boolean {
  return !!value && /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(value);
}

function preferPackage(current?: string, candidate?: string): string | undefined {
  if (looksLikeAndroidPackage(current)) {
    return current;
  }
  if (looksLikeAndroidPackage(candidate)) {
    return candidate;
  }
  return current ?? candidate;
}

export function resolveEnv(): Env {
  const p: Platform =
    Process.platform === 'darwin' ? 'ios' : Process.platform === 'linux' ? 'android' : 'unknown';

  let appId: string | undefined;
  let appVer: string | undefined;

  try {
    if (p === 'ios' && (globalThis as any).ObjC?.available) {
      const bundle = ObjC.classes?.NSBundle?.mainBundle();
      if (bundle) {
        appId = bundle.bundleIdentifier()?.toString();
        appVer = bundle.infoDictionary()?.objectForKey_('CFBundleShortVersionString')?.toString();
      }
    }
  } catch {
    // Keep environment resolution non-fatal.
  }

  return {
    platform: p,
    appId,
    appVer,
    arch: Process.arch,
    javaAvailable: p === 'android' ? isJavaAvailable() : false,
    objcAvailable: (globalThis as any).ObjC?.available ?? false,
  };
}

async function resolveAndroidEnv(base: Env): Promise<Env> {
  if (!isJavaAvailable()) {
    return base;
  }

  let appId = base.appId;
  let appVer = base.appVer;

  try {
    await performOnJava(() => {
      const applyPackage = (candidate: any) => {
        appId = preferPackage(appId, coerceString(candidate));
      };
      const applyVersion = (candidate: any) => {
        appVer = appVer ?? coerceString(candidate);
      };

      try {
        const ActivityThread = Java.use('android.app.ActivityThread');
        const currentApplication = ActivityThread.currentApplication?.();

        if (currentApplication) {
          const appContext = currentApplication.getApplicationContext?.() ?? currentApplication;
          applyPackage(appContext?.getPackageName?.());
          applyPackage(currentApplication.getPackageName?.());

          try {
            const packageManager = currentApplication.getPackageManager?.();
            if (packageManager && appId) {
              const packageInfo = packageManager.getPackageInfo(appId, 0);
              applyVersion(packageInfo?.versionName);
            }
          } catch {
            // Keep version resolution non-fatal.
          }
        }
        applyPackage(ActivityThread.currentPackageName?.());
        applyPackage(ActivityThread.currentProcessName?.());
      } catch {
        // Keep ActivityThread probing non-fatal.
      }

      if (!looksLikeAndroidPackage(appId)) {
        try {
          const AppGlobals = Java.use('android.app.AppGlobals');
          applyPackage(AppGlobals.getInitialPackage?.());
        } catch {
          // Keep AppGlobals probing non-fatal.
        }
      }

      if (!looksLikeAndroidPackage(appId)) {
        try {
          const Application = Java.use('android.app.Application');
          const app = Application.$new?.();
          applyPackage(app?.getPackageName?.());
        } catch {
          // Application instantiation is not guaranteed to work; ignore.
        }
      }

      if (!looksLikeAndroidPackage(appId)) {
        appId = coerceString(Process.enumerateModules()[0]?.name) ?? appId;
      }
    });
  } catch {
    // Keep async environment resolution non-fatal.
  }

  return {
    ...base,
    appId,
    appVer,
    javaAvailable: isJavaAvailable(),
  };
}

export async function resolveEnvAsync(): Promise<Env> {
  const base = resolveEnv();
  return base.platform === 'android' ? await resolveAndroidEnv(base) : base;
}
