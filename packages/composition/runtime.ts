import { Java, initializeJavaClassLoader, performOnJava } from '@runtime/java-bridge';
import { androidApi } from '@modules/android-runtime-bypass/api-runtime';
import type { AndroidApiPolicy } from '@modules/android-runtime-bypass/api-policy';
import type { HookOptions } from '@modules/android-runtime-bypass/api-hooks';
import { createScopes } from './ownership';
import type { Cleanup, ExtensionContext } from './types';

type Managed = {
  id: string;
  modes: string[];
  module: { activate: (ctx: ExtensionContext) => Cleanup | Promise<Cleanup> };
};
export function registerComposition(
  selection: HookOptions,
  policy: AndroidApiPolicy,
  declared: Record<string, string>,
  managed: Managed[]
) {
  const scopes = createScopes(declared);
  let state = 'new';
  const emit = (type: string, data?: unknown) => send({ type, data });
  const cleanups: Cleanup[] = [];
  let activation: Promise<unknown> | undefined;
  let nativePrepared = false;
  let stopping: Promise<{ restored: boolean }> | undefined;
  function stop(): Promise<{ restored: boolean }> {
    if (stopping) {
      return stopping;
    }
    state = 'closing';
    scopes.beginClose();
    androidApi.beginDispose();
    stopping = (async () => {
      const failures: string[] = [];
      // Await the activation task, not the RPC wrapper that invokes rollback.
      // Closing the scope prevents pending activations from acquiring more work.
      await activation?.catch(() => {});
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(String(error));
        }
      }
      const scope = await scopes.close();
      failures.push(...scope.failures);
      try {
        await androidApi.dispose();
      } catch (error) {
        failures.push(String(error));
      }
      state = 'stopped';
      if (failures.length) {
        throw new Error('Composition cleanup failed: ' + failures.join('; '));
      }
      emit('composition-stopped');
      return { restored: true };
    })();
    return stopping;
  }
  rpc.exports = {
    ...rpc.exports,
    async preparenative() {
      if (state !== 'new') {
        throw new Error('Native preparation already started');
      }
      state = 'native-starting';
      try {
        activation = (async () => {
          androidApi.prepare(selection);
          const installed = await androidApi.prepareNative(policy);
          if (state !== 'native-starting') {
            throw new Error('Composition is stopping');
          }
          nativePrepared = true;
          state = 'native-ready';
          const receipt = { pid: Process.id, readyAt: Date.now(), policy, ...installed };
          emit('composition-native-ready', receipt);
          return receipt;
        })();
        return await activation;
      } catch (error) {
        await stop();
        throw error;
      }
    },
    async start() {
      if (state !== 'new' && state !== 'native-ready') {
        throw new Error('Composition already started');
      }
      state = 'starting';
      try {
        activation = (async () => {
          if (!(await initializeJavaClassLoader(60000, () => state !== 'starting'))) {
            throw new Error('Application ClassLoader unavailable');
          }
          if (state !== 'starting') {
            throw new Error('Composition is stopping');
          }
          if (!nativePrepared) {
            androidApi.prepare(selection);
          }
          await androidApi.configure(policy);
          if (state !== 'starting') {
            throw new Error('Composition is stopping');
          }
          for (const item of managed) {
            if (typeof item.module.activate !== 'function') {
              throw new Error(item.id + ' lacks activate(ctx)');
            }
            const context: ExtensionContext = {
              id: item.id,
              modes: item.modes,
              Java,
              performOnJava,
              log: message => emit('extension-log', { id: item.id, message }),
              emit: (type, data) => emit(type, { extension: item.id, value: data }),
              api: {
                policy: androidApi.policy,
                subscribe(listener) {
                  if (state === 'closing' || state === 'stopped') {
                    throw new Error('Composition is stopping');
                  }
                  const unsubscribe = androidApi.subscribe(listener);
                  scopes.forOwner(item.id).defer(unsubscribe);
                  return unsubscribe;
                },
              },
              scope: scopes.forOwner(item.id),
            };
            const active: { cleanup?: Cleanup } = {};
            // Enroll before activation so a partially installed extension rolls
            // back before earlier extensions, including its registered resources.
            cleanups.push(async () => {
              const failures: string[] = [];
              try {
                if (active.cleanup) {
                  await active.cleanup();
                }
              } catch (error) {
                failures.push(String(error));
              }
              const closed = await scopes.closeOwner(item.id);
              failures.push(...closed.failures);
              if (failures.length) {
                throw new Error(failures.join('; '));
              }
            });
            const activated = await item.module.activate(context);
            if (typeof activated !== 'function') {
              throw new Error(item.id + ' must return a cleanup function');
            }
            active.cleanup = activated;
            if (state !== 'starting') {
              throw new Error('Composition is stopping');
            }
            emit('extension-active', { id: item.id });
          }
          state = 'ready';
          emit('composition-ready', androidApi.status());
          return { pid: Process.id, arch: Process.arch, ...androidApi.status() };
        })();
        return await activation;
      } catch (error) {
        try {
          await stop();
        } catch (cleanup) {
          throw new Error(String(error) + '; rollback: ' + cleanup);
        }
        throw error;
      }
    },
    configure(input: AndroidApiPolicy) {
      if (state !== 'ready') {
        throw new Error('Composition is not ready');
      }
      return androidApi.configure(input);
    },
    status() {
      return { state, ...androidApi.status() };
    },
    dispose: stop,
  };
}
