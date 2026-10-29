import { initializeJavaClassLoader } from '@runtime/java-bridge';
import { createAndroidApiHooks, type HookOptions } from './api-hooks';
import { parsePolicy, type AndroidApiPolicy } from './api-policy';

/** A Script has one system-API owner, regardless of RPC/modules/subscribers. */
export function createApiRuntime() {
  let hooks: Awaited<ReturnType<typeof createAndroidApiHooks>> | undefined;
  let creating: Promise<void> | undefined;
  let installing: Promise<void> | undefined;
  let options: HookOptions = {};
  let stopped = false;
  let leases = 0;
  async function create(nativeOnly: boolean) {
    if (!creating) {
      creating = (async () => {
        hooks = await createAndroidApiHooks({ mode: 'observe' }, { ...options, nativeOnly });
      })();
    }
    await creating;
    if (stopped) {
      throw new Error('Shared API runtime disposed');
    }
    return hooks!;
  }
  async function ensure() {
    if (stopped) {
      throw new Error('Shared API runtime disposed');
    }
    if (!installing) {
      installing = (async () => {
        if (!(await initializeJavaClassLoader(60000, () => stopped))) {
          throw new Error('Android Application ClassLoader not ready');
        }
        if (stopped) {
          throw new Error('Shared API runtime disposed');
        }
        const owner = await create(false);
        await owner.activateJava();
      })();
    }
    await installing;
    return hooks!;
  }
  return {
    prepare(selection: HookOptions) {
      if (installing || creating || stopped) {
        throw new Error('API installation scope is already fixed');
      }
      options = selection;
    },
    async prepareNative(input: AndroidApiPolicy) {
      if (stopped || installing || creating) {
        throw new Error('Native preparation must precede Java activation');
      }
      const policy = parsePolicy(input);
      const owner = await create(true);
      await owner.configure(policy);
      return owner.status();
    },
    beginDispose() {
      stopped = true;
      hooks?.stopIntervention();
    },
    async configure(input: AndroidApiPolicy) {
      const policy = parsePolicy(input);
      const owner = await ensure();
      return owner.configure(policy);
    },
    async acquire(policy?: AndroidApiPolicy) {
      const owner = await ensure();
      if (policy) {
        await owner.configure(policy);
      }
      leases++;
      let released = false;
      return {
        owner,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          if (--leases === 0) {
            await owner.dispose();
            stopped = true;
          }
        },
      };
    },
    drain() {
      if (!hooks) {
        throw new Error('Configure API hooks first');
      }
      return hooks.drain();
    },
    policy() {
      return hooks?.policy() ?? { mode: 'observe' as const };
    },
    subscribe(
      listener: Parameters<Awaited<ReturnType<typeof createAndroidApiHooks>>['subscribe']>[0]
    ) {
      if (!hooks) {
        throw new Error('Configure API hooks first');
      }
      return hooks.subscribe(listener);
    },
    status() {
      return (
        hooks?.status() ?? {
          installed: [],
          groups: [],
          unavailable: [],
          counts: { calls: 0, matched: 0, changed: 0, errors: 0 },
          closed: stopped,
        }
      );
    },
    async dispose() {
      stopped = true;
      hooks?.stopIntervention();
      if (creating) {
        await creating.catch(() => {});
      }
      if (installing) {
        await installing.catch(() => {});
      }
      return hooks ? hooks.dispose() : { restored: true };
    },
  };
}
export const androidApi = createApiRuntime();
