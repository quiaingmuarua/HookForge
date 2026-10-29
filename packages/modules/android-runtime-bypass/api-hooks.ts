import { Java, performOnJava } from '@runtime/java-bridge';
import { resolveExportByName } from '@runtime/native-bridge';
import { emitTraceEvent } from '@events/sink';
import {
  AndroidApiPolicy,
  parsePolicy,
  resolveBuildFields,
  transformCommandOutput,
  nativePropertyLength,
} from './api-policy';
import { createBuildFieldOwner } from './build-fields';

export type ApiObservation = {
  ts?: number;
  api: string;
  phase?: 'enter' | 'leave';
  args: unknown;
  mode: AndroidApiPolicy['mode'];
  original?: unknown;
  result?: unknown;
  changed?: boolean;
  matched?: boolean;
  error?: string;
  runtimeError?: boolean;
  originalReturn?: number;
  resultReturn?: number;
  caller?: { stack?: string[]; module?: string; address?: string };
};
export type ApiGroup =
  | 'file-io'
  | 'system-properties'
  | 'packages'
  | 'build'
  | 'build-fields'
  | 'commands';
export const allApiGroups: ApiGroup[] = [
  'file-io',
  'system-properties',
  'packages',
  'build',
  'build-fields',
  'commands',
];
export type HookOptions = { groups?: ApiGroup[]; traceGroups?: ApiGroup[]; nativeOnly?: boolean };

/** One owner per injected script: install once, change rules, restore and dispose. */
export async function createAndroidApiHooks(initial: AndroidApiPolicy, options: HookOptions = {}) {
  const groups = new Set(options.groups ?? allApiGroups);
  const trace = new Set(options.traceGroups ?? [...groups]);
  const subscribers = new Set<{ listener: (event: ApiObservation) => void; enter: boolean }>();
  const installed: string[] = [];
  const counts = { calls: 0, matched: 0, changed: 0, errors: 0, runtimeErrors: 0 };
  let policy = parsePolicy(initial);
  let closed = false;
  let dropped = 0;
  const records: ApiObservation[] = [];
  const methods: any[] = [];
  const listeners: InvocationListener[] = [];
  const propertyReads = new Map<string, any>();
  const propertyGets = new Set<any>();
  const propertyCallbacks = new Map<string, NativeFunction>();
  let propertyDispatcher: NativePointer | null = null;
  const commandDepth = new Map<number, number>();
  let closing = false;
  let javaStarted = false;
  let javaActivation: Promise<void> | undefined;
  const maxRecords = 4096;
  let originalTags: any;
  let Build: any;
  let buildFields: ReturnType<typeof createBuildFieldOwner> | undefined;
  let Exception: any;
  let Log: any;
  let OutputProcess: any;

  function notify(item: ApiObservation) {
    for (const subscription of subscribers) {
      if (item.phase === 'enter' && !subscription.enter) {
        continue;
      }
      try {
        subscription.listener(JSON.parse(JSON.stringify(item)));
      } catch (error) {
        const failure = {
          api: 'observer',
          args: { api: item.api },
          mode: item.mode,
          error: String(error),
          runtimeError: true,
        } as ApiObservation;
        counts.errors++;
        counts.runtimeErrors++;
        if (records.length < maxRecords) {
          records.push(failure);
        } else {
          dropped++;
        }
        try {
          send({ type: 'composition-error', error: failure.error });
        } catch {
          /* The buffered failure remains authoritative. */
        }
      }
    }
  }

  function record(observation: Omit<ApiObservation, 'mode'>, active = policy) {
    const item = { ts: Date.now(), ...observation, phase: 'leave' as const, mode: active.mode };
    counts.calls++;
    if (item.matched) {
      counts.matched++;
    }
    if (item.changed) {
      counts.changed++;
    }
    if (item.error) {
      counts.errors++;
    }
    if (item.runtimeError) {
      counts.runtimeErrors++;
    }
    notify(item);
    const group: ApiGroup =
      item.api.startsWith('SystemProperties') || item.api.startsWith('libc.__system_property')
        ? 'system-properties'
        : item.api.startsWith('Runtime.') || item.api === 'ProcessBuilder.start'
          ? (item.args as any)?.argv?.length === 1 &&
            ['getprop', '/system/bin/getprop'].includes((item.args as any).argv[0])
            ? 'system-properties'
            : 'commands'
          : item.api.startsWith('PackageManager')
            ? 'packages'
            : 'file-io';
    if (!trace.has(group) && !item.matched && !item.changed && !item.error) {
      return;
    }
    if (records.length < maxRecords) {
      records.push(item);
    } else {
      dropped += 1;
    }
    emitTraceEvent({
      ts: Date.now(),
      source: 'module',
      module: 'android/api-hooks',
      point: item.api,
      kind: item.error ? 'error' : item.changed ? 'bypass' : 'trace',
      phase: 'leave',
      context: { processId: Process.id },
      data: item,
    });
  }

  function caller(active = policy) {
    if (!active.captureStack) {
      return undefined;
    }
    return { stack: String(Log.getStackTraceString(Exception.$new())).split('\n').slice(1, 22) };
  }

  function readStream(stream: any) {
    const scanner = Java.use('java.util.Scanner').$new(stream).useDelimiter('\\A');
    try {
      return scanner.hasNext() ? String(scanner.next()) : '';
    } finally {
      scanner.close();
    }
  }

  function registerProcess() {
    OutputProcess = Java.registerClass({
      name: 'org.agentforge.api.OutputProcess',
      superClass: Java.use('java.lang.Process'),
      fields: { child: 'java.lang.Process', stdout: 'java.io.InputStream' },
      methods: {
        $init: [
          {
            returnType: 'void',
            argumentTypes: ['java.lang.Process', 'java.lang.String'],
            implementation(this: any, child: any, text: any) {
              this.$super.$init();
              this.child.value = child;
              this.stdout.value = Java.use('java.io.ByteArrayInputStream').$new(
                Java.use('java.lang.String').$new(text).getBytes('UTF-8')
              );
            },
          },
        ],
        getInputStream: {
          returnType: 'java.io.InputStream',
          argumentTypes: [],
          implementation(this: any) {
            return this.stdout.value;
          },
        },
        getErrorStream: {
          returnType: 'java.io.InputStream',
          argumentTypes: [],
          implementation(this: any) {
            return this.child.value.getErrorStream();
          },
        },
        getOutputStream: {
          returnType: 'java.io.OutputStream',
          argumentTypes: [],
          implementation(this: any) {
            return this.child.value.getOutputStream();
          },
        },
        waitFor: [
          {
            returnType: 'int',
            argumentTypes: [],
            implementation(this: any) {
              return this.child.value.waitFor();
            },
          },
          {
            returnType: 'boolean',
            argumentTypes: ['long', 'java.util.concurrent.TimeUnit'],
            implementation(this: any, timeout: any, unit: any) {
              return this.child.value.waitFor(timeout, unit);
            },
          },
        ],
        exitValue: {
          returnType: 'int',
          argumentTypes: [],
          implementation(this: any) {
            return this.child.value.exitValue();
          },
        },
        destroy(this: any) {
          this.child.value.destroy();
        },
        isAlive: {
          returnType: 'boolean',
          argumentTypes: [],
          implementation(this: any) {
            return this.child.value.isAlive();
          },
        },
        destroyForcibly: {
          returnType: 'java.lang.Process',
          argumentTypes: [],
          implementation(this: any) {
            this.child.value.destroyForcibly();
            return this;
          },
        },
      },
    });
  }

  // Runtime.exec delegates to ProcessBuilder. Suppress only that thread's nested
  // start, retaining the original Runtime event consumed by the existing case.
  function command(
    api: string,
    argv: string[],
    active: AndroidApiPolicy,
    launch: (replacement?: string[]) => any
  ) {
    const source = caller(active);
    notify({ api, args: { argv }, mode: active.mode, phase: 'enter', caller: source });
    const thread = Process.getCurrentThreadId();
    try {
      const redirect =
        active.mode === 'replace'
          ? active.rules?.commandRedirects?.find(
              item => JSON.stringify(item.argv) === JSON.stringify(argv)
            )
          : undefined;
      let child: any;
      commandDepth.set(thread, (commandDepth.get(thread) ?? 0) + 1);
      try {
        child = launch(redirect?.replacement);
      } finally {
        const depth = commandDepth.get(thread)! - 1;
        if (depth) {
          commandDepth.set(thread, depth);
        } else {
          commandDepth.delete(thread);
        }
      }
      if (redirect) {
        record(
          {
            api,
            args: { argv },
            result: { argv: redirect.replacement },
            changed: true,
            matched: true,
            caller: source,
          },
          active
        );
        return child;
      }
      const properties =
        argv.length === 1 &&
        ['getprop', '/system/bin/getprop'].includes(argv[0]) &&
        Object.keys(active.rules?.properties ?? {}).length > 0;
      const mounts =
        argv.length === 1 &&
        ['mount', '/system/bin/mount'].includes(argv[0]) &&
        (active.rules?.readOnlyMounts?.length ?? 0) > 0;
      if (active.mode === 'observe' || (!properties && !mounts)) {
        record(
          { api, args: { argv }, result: 'real-process', changed: false, caller: source },
          active
        );
        return child;
      }
      const original = readStream(child.getInputStream());
      const exitCode = Number(child.waitFor());
      const result = transformCommandOutput(argv, original, active);
      record(
        {
          api,
          args: { argv },
          original: { stdout: original, exitCode },
          result: { stdout: result, exitCode },
          changed: original !== result,
          matched: true,
          caller: source,
        },
        active
      );
      return OutputProcess.$new(child, result);
    } catch (error) {
      record({ api, args: { argv }, error: String(error), caller: source }, active);
      throw error;
    }
  }

  function installJava() {
    if (groups.has('build') || groups.has('build-fields')) {
      Build = Java.use('android.os.Build');
      originalTags = Build.TAGS.value;
      buildFields = createBuildFieldOwner(Build);
      installed.push(groups.has('build-fields') ? 'Build.fields' : 'Build.TAGS');
    }
    Exception = Java.use('java.lang.Exception');
    Log = Java.use('android.util.Log');

    if (groups.has('file-io')) {
      const File = Java.use('java.io.File');
      const exists = File.exists.overload();
      exists.implementation = function (this: any) {
        const path = String(this.getAbsolutePath());
        const original = Boolean(exists.call(this));
        const rules = policy.rules?.fileExists ?? {};
        const matched =
          policy.mode === 'replace' && Object.prototype.hasOwnProperty.call(rules, path);
        const result = matched ? rules[path] : original;
        record({
          api: 'java.io.File.exists',
          args: { path },
          original,
          result,
          changed: original !== result,
          matched,
          caller: caller(),
        });
        return result;
      };
      methods.push(exists);
      installed.push('java.io.File.exists');
    }

    if (groups.has('packages')) {
      const getPackageInfo = Java.use(
        'android.app.ApplicationPackageManager'
      ).getPackageInfo.overload('java.lang.String', 'int');
      getPackageInfo.implementation = function (this: any, name: any, flags: number) {
        const hidden =
          policy.mode === 'replace' && (policy.rules?.packagesAbsent ?? []).includes(String(name));
        let result: any;
        let missing: any = null;
        try {
          result = getPackageInfo.call(this, name, flags);
        } catch (error) {
          if (!String(error).includes('NameNotFoundException')) {
            record({
              api: 'PackageManager.getPackageInfo',
              args: { name: String(name), flags },
              error: String(error),
              caller: caller(),
            });
            throw error;
          }
          missing = error;
        }
        record({
          api: 'PackageManager.getPackageInfo',
          args: { name: String(name), flags },
          original: missing ? 'absent' : 'present',
          result: missing || hidden ? 'absent' : 'present',
          changed: hidden && !missing,
          matched: hidden,
          caller: caller(),
        });
        if (missing) {
          throw missing;
        }
        if (hidden) {
          throw Java.use('android.content.pm.PackageManager$NameNotFoundException').$new(
            String(name)
          );
        }
        return result;
      };
      methods.push(getPackageInfo);
      installed.push('PackageManager.getPackageInfo');
    }

    if (groups.has('system-properties')) {
      for (const signature of [['java.lang.String'], ['java.lang.String', 'java.lang.String']]) {
        const get = Java.use('android.os.SystemProperties').get.overload(...signature);
        get.implementation = function (this: any, ...args: any[]) {
          const active = policy;
          const key = String(args[0]);
          notify({
            api: `SystemProperties.get(${signature.length})`,
            args: { key, ...(args.length === 2 ? { defaultValue: String(args[1]) } : {}) },
            mode: active.mode,
            phase: 'enter',
          });
          const original = String(get.call(this, ...args));
          const rules = active.rules?.properties ?? {};
          const result =
            active.mode === 'replace' && Object.prototype.hasOwnProperty.call(rules, key)
              ? rules[key]
              : original;
          record(
            {
              api: `SystemProperties.get(${signature.length})`,
              args: { key, ...(args.length === 2 ? { defaultValue: String(args[1]) } : {}) },
              original,
              result,
              changed: original !== result,
              matched:
                active.mode === 'replace' && Object.prototype.hasOwnProperty.call(rules, key),
              caller: caller(active),
            },
            active
          );
          return result;
        };
        methods.push(get);
        installed.push(`SystemProperties.get(${signature.length})`);
      }
    }

    if (groups.has('commands') || groups.has('system-properties')) {
      registerProcess();
      const Runtime = Java.use('java.lang.Runtime');
      for (const type of ['java.lang.String', '[Ljava.lang.String;']) {
        const exec = Runtime.exec.overload(type);
        exec.implementation = function (this: any, argument: any) {
          const argv: string[] =
            type === 'java.lang.String'
              ? String(argument).trim().split(/\s+/)
              : Array.from(argument, String);
          const api = `Runtime.exec(${type})`;
          return command(api, argv, policy, replacement =>
            exec.call(
              this,
              replacement
                ? type === 'java.lang.String'
                  ? replacement.join(' ')
                  : Java.array('java.lang.String', replacement)
                : argument
            )
          );
        };
        methods.push(exec);
      }

      const start = Java.use('java.lang.ProcessBuilder').start.overload();
      start.implementation = function (this: any) {
        if (commandDepth.has(Process.getCurrentThreadId())) {
          return start.call(this);
        }
        const original = this.command();
        const argv = Array.from(original.toArray(), String);
        return command('ProcessBuilder.start', argv, policy, replacement => {
          if (!replacement) {
            return start.call(this);
          }
          try {
            this.command
              .overload('[Ljava.lang.String;')
              .call(this, Java.array('java.lang.String', replacement));
            return start.call(this);
          } finally {
            this.command.overload('java.util.List').call(this, original);
          }
        });
      };
      methods.push(start);
      installed.push(
        'Runtime.exec(java.lang.String)',
        'Runtime.exec([Ljava.lang.String;)',
        'ProcessBuilder.start'
      );
    }
  }

  function installNative() {
    if (groups.has('system-properties')) {
      const get = resolveExportByName('__system_property_get');
      const find = resolveExportByName('__system_property_find');
      const read = resolveExportByName('__system_property_read_callback');
      if (get === null || find === null || read === null) {
        throw new Error('Required libc property API unavailable: get/find/read_callback');
      }
      const lookup = new NativeFunction(find, 'pointer', ['pointer']);
      listeners.push(
        Interceptor.attach(get, {
          onEnter(args) {
            this.propertyGet = undefined;
            if (closing) {
              return;
            }
            const state = {
              active: policy,
              name: args[0],
              key: args[0].readCString(),
              buffer: args[1],
              source: {
                module: Process.findModuleByAddress(this.returnAddress)?.name ?? 'unknown',
                address: this.returnAddress.toString(),
              },
            };
            this.propertyGet = state;
            propertyGets.add(state);
          },
          onLeave(retval) {
            const state = this.propertyGet;
            if (!state) {
              return;
            }
            const originalReturn = retval.toInt32();
            let original: string | null = null;
            let result: string | null = null;
            let resultReturn = originalReturn;
            let found = originalReturn > 0;
            let matched = false;
            let error: string | undefined;
            try {
              if (originalReturn < 0 || originalReturn > 91) {
                throw new Error('Invalid __system_property_get return length');
              }
              original = state.buffer.readUtf8String();
              if (original === null) {
                throw new Error('Null native property output');
              }
              result = original;
              matched =
                state.active.mode === 'replace' &&
                state.key !== null &&
                Object.prototype.hasOwnProperty.call(
                  state.active.rules?.properties ?? {},
                  state.key
                );
              if (matched) {
                // A zero return also represents an existing empty property.
                found = found || !lookup(state.name).isNull();
                if (found) {
                  const replacement = state.active.rules.properties[state.key];
                  const length = nativePropertyLength(replacement);
                  state.buffer.writeUtf8String(replacement);
                  retval.replace(length);
                  result = replacement;
                  resultReturn = length;
                }
              }
            } catch (failure) {
              error = String(failure);
              if (original !== null) {
                try {
                  state.buffer.writeUtf8String(original);
                  retval.replace(originalReturn);
                } catch (rollback) {
                  error += '; buffer rollback: ' + rollback;
                }
              }
              result = original;
              resultReturn = originalReturn;
            } finally {
              propertyGets.delete(state);
            }
            record(
              {
                api: 'libc.__system_property_get',
                args: { key: state.key, found },
                original,
                result,
                originalReturn,
                resultReturn,
                matched,
                changed: original !== result || originalReturn !== resultReturn,
                error,
                runtimeError: Boolean(error),
                caller: state.source,
              },
              state.active
            );
          },
        })
      );
      installed.push('libc.__system_property_get');
      listeners.push(
        Interceptor.attach(find, {
          onEnter(args) {
            this.active = policy;
            this.key = args[0].readCString();
            this.source = {
              module: Process.findModuleByAddress(this.returnAddress)?.name ?? 'unknown',
              address: this.returnAddress.toString(),
            };
          },
          onLeave(value) {
            record(
              {
                api: 'libc.__system_property_find',
                args: { key: this.key },
                original: { found: !value.isNull() },
                result: { found: !value.isNull() },
                changed: false,
                caller: this.source,
              },
              this.active
            );
          },
        })
      );
      installed.push('libc.__system_property_find', 'libc.__system_property_read_callback');
      // A single executable callback lives for this installation. Individual
      // reads own only their opaque cookie, immutable policy and value storage.
      propertyDispatcher = new NativeCallback(
        (context, name, value, serial) => {
          const state = propertyReads.get(context.toString());
          if (!state) {
            throw new Error('Unknown native property read context');
          }
          const { active, source } = state;
          let key: string | null = null;
          let original: string | null = null;
          let result: string | null = null;
          let delivered = value;
          let matched = false;
          let error: string | undefined;
          try {
            key = name.readCString();
            original = value.readCString();
            matched =
              active.mode === 'replace' &&
              key !== null &&
              Object.prototype.hasOwnProperty.call(active.rules?.properties ?? {}, key);
            result = matched ? active.rules!.properties![key!] : original;
            if (matched) {
              state.allocation = Memory.allocUtf8String(result!);
              delivered = state.allocation;
            }
          } catch (failure) {
            error = String(failure);
          }
          state.callback(state.cookie, name, delivered, serial);
          record(
            {
              api: 'libc.__system_property_read_callback',
              args: { key, serial },
              original,
              result,
              matched,
              changed: matched && original !== result,
              error,
              runtimeError: Boolean(error),
              caller: source,
            },
            active
          );
        },
        'void',
        ['pointer', 'pointer', 'pointer', 'uint32']
      );
      listeners.push(
        Interceptor.attach(read, {
          onEnter(args) {
            this.propertyRead = undefined;
            if (closing) {
              return;
            }
            const address = args[1].toString();
            let callback = propertyCallbacks.get(address);
            if (!callback) {
              // Keep the application's native failure handling; do not install an
              // exception-stealing scope around its callback on an app thread.
              callback = new NativeFunction(
                args[1],
                'void',
                ['pointer', 'pointer', 'pointer', 'uint32'],
                { exceptions: 'propagate' }
              );
              propertyCallbacks.set(address, callback);
            }
            const state = {
              context: Memory.alloc(1),
              cookie: args[2],
              callback,
              active: policy,
              source: {
                module: Process.findModuleByAddress(this.returnAddress)?.name ?? 'unknown',
                address: this.returnAddress.toString(),
              },
              allocation: null,
            };
            this.propertyRead = state;
            propertyReads.set(state.context.toString(), state);
            args[1] = propertyDispatcher!;
            args[2] = state.context;
          },
          onLeave() {
            if (this.propertyRead) {
              propertyReads.delete(this.propertyRead.context.toString());
            }
          },
        })
      );
    }
    if (groups.has('file-io')) {
      for (const symbol of ['fopen', 'access', 'stat', 'open']) {
        const address = resolveExportByName(symbol);
        if (address === null) {
          throw new Error(`Required libc ${symbol} export unavailable`);
        }
        listeners.push(
          Interceptor.attach(address, {
            onEnter(args) {
              this.originalPath = args[0].isNull() ? null : args[0].readCString();
              this.callerModule =
                Process.findModuleByAddress(this.returnAddress)?.name ?? 'unknown';
              this.callerAddress = this.returnAddress.toString();
              this.replacement =
                policy.mode === 'replace' && this.originalPath !== null
                  ? policy.rules?.nativeFileRedirects?.[this.originalPath]
                  : undefined;
              if (this.replacement !== undefined) {
                this.pathAllocation = Memory.allocUtf8String(this.replacement);
                args[0] = this.pathAllocation;
              }
            },
            onLeave(retval) {
              const result =
                symbol === 'fopen'
                  ? { opened: !retval.isNull() }
                  : { returnCode: retval.toInt32() };
              record({
                api: `libc.${symbol}`,
                args: { path: this.originalPath, redirectedTo: this.replacement },
                result,
                changed: this.replacement !== undefined && this.replacement !== this.originalPath,
                matched: this.replacement !== undefined,
                caller: { module: this.callerModule, address: this.callerAddress },
              });
            },
          })
        );
        installed.push('libc.' + symbol);
      }
    }
    Interceptor.flush();
  }

  async function configure(input: AndroidApiPolicy) {
    const next = parsePolicy(input);
    const required: Record<string, ApiGroup> = {
      fileExists: 'file-io',
      nativeFileRedirects: 'file-io',
      properties: 'system-properties',
      packagesAbsent: 'packages',
      buildTags: 'build',
      buildFields: 'build-fields',
      commandRedirects: 'commands',
      readOnlyMounts: 'commands',
    };
    for (const field of Object.keys(next.rules ?? {})) {
      if (!groups.has(required[field]) && !(field === 'buildTags' && groups.has('build-fields'))) {
        throw new Error('API group was not selected for rule ' + field);
      }
    }
    if (closed || closing) {
      throw new Error('API hooks have been disposed');
    }
    const apply = () => {
      policy = { mode: 'observe' };
      try {
        buildFields?.apply(next.mode === 'replace' ? resolveBuildFields(next) : {});
        policy = next;
      } catch (error) {
        policy = { mode: 'observe' };
        throw error;
      }
      return {
        mode: policy.mode,
        buildTags: Build
          ? { original: String(originalTags), current: String(Build.TAGS.value) }
          : undefined,
        buildFields: buildFields?.snapshot() ?? {},
      };
    };
    return buildFields ? performOnJava(apply) : apply();
  }

  async function dispose() {
    if (closed) {
      return { restored: true };
    }
    closing = true;
    policy = { mode: 'observe' };
    const failures: string[] = [];
    if (javaStarted) {
      await performOnJava(() => {
        policy = { mode: 'observe' };
        try {
          buildFields?.restore();
        } catch (error) {
          failures.push(String(error));
        }
        for (const method of methods.splice(0).reverse()) {
          try {
            method.implementation = null;
          } catch (error) {
            failures.push(String(error));
          }
        }
      });
    }
    const deadline = Date.now() + 5000;
    // Closing entries pass through. Keep onLeave installed until the last
    // wrapped callback has returned, then release its executable closure.
    while (propertyReads.size || propertyGets.size) {
      if (Date.now() >= deadline) {
        throw new Error('Native property reads still in flight during dispose');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    for (const listener of listeners.splice(0)) {
      listener.detach();
    }
    Interceptor.flush();
    propertyCallbacks.clear();
    propertyDispatcher = null;
    if (failures.length) {
      throw new Error('API restoration failed: ' + failures.join('; '));
    }
    closed = true;
    subscribers.clear();
    return { restored: true };
  }

  async function activateJava() {
    if (closed || closing) {
      throw new Error('API hooks have been disposed');
    }
    if (!javaActivation) {
      javaActivation = performOnJava(() => {
        if (closed || closing) {
          throw new Error('API hooks have been disposed');
        }
        javaStarted = true;
        installJava();
      });
    }
    await javaActivation;
  }
  try {
    if (!options.nativeOnly) {
      await activateJava();
    }
    installNative();
    await configure(initial);
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    activateJava,
    stopIntervention() {
      policy = { mode: 'observe' };
    },
    configure,
    dispose,
    policy: () => parsePolicy(policy),
    subscribe(listener: (event: ApiObservation) => void, options: { enter?: boolean } = {}) {
      if (closed || closing) {
        throw new Error('API hooks have been disposed');
      }
      const subscription = { listener, enter: options.enter === true };
      subscribers.add(subscription);
      return () => {
        subscribers.delete(subscription);
      };
    },
    status: () => ({
      groups: [...groups],
      installed: [...installed],
      unavailable: [],
      counts: { ...counts },
      buildFields: buildFields?.snapshot() ?? {},
      closed,
    }),
    drain() {
      const result = { records: records.splice(0), dropped };
      dropped = 0;
      return result;
    },
  };
}
