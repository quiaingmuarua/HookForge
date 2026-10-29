import { buildFieldNames } from '../modules/android-runtime-bypass/api-policy';

// Canonical identifiers for managed system hooks. This is an ownership map,
// not a source scanner or a claim about arbitrary third-party script behavior.
export const sharedHookIds = [
  'java.io.File.exists',
  'PackageManager.getPackageInfo',
  ...buildFieldNames.map(name => 'Build.' + name),
  'SystemProperties.get(1)',
  'SystemProperties.get(2)',
  'Runtime.exec(java.lang.String)',
  'Runtime.exec([Ljava.lang.String;)',
  'ProcessBuilder.start',
  'libc.fopen',
  'libc.access',
  'libc.stat',
  'libc.open',
  'libc.__system_property_get',
  'libc.__system_property_find',
  'libc.__system_property_read_callback',
];

export function createScopes(declared: Record<string, string>) {
  const owners = new Map(Object.entries(declared));
  let closing = false;
  const cleanups: { owner: string; run: () => void | Promise<void> }[] = [];
  async function closeOwner(owner?: string) {
    const failures: string[] = [];
    for (let index = cleanups.length - 1; index >= 0; index--) {
      if (owner && cleanups[index].owner !== owner) {
        continue;
      }
      const [cleanup] = cleanups.splice(index, 1);
      try {
        await cleanup.run();
      } catch (error) {
        failures.push(String(error));
      }
    }
    return { complete: failures.length === 0, failures };
  }
  return {
    beginClose() {
      closing = true;
    },
    forOwner(owner: string) {
      return {
        own(id: string, cleanup: () => void | Promise<void>) {
          if (closing) {
            throw new Error('Scope is closing');
          }
          if (!id || sharedHookIds.includes(id) || id.startsWith('shared:')) {
            throw new Error('Use the shared API owner for ' + id);
          }
          const prior = owners.get(id);
          if (prior && prior !== owner) {
            throw new Error('Hook ownership conflict: ' + id);
          }
          // A declared claim may be fulfilled once, but never acquired twice.
          if (owners.get('active:' + id)) {
            throw new Error('Hook already acquired: ' + id);
          }
          owners.set(id, owner);
          owners.set('active:' + id, owner);
          cleanups.push({ owner, run: cleanup });
        },
        defer(cleanup: () => void | Promise<void>) {
          if (closing) {
            throw new Error('Scope is closing');
          }
          cleanups.push({ owner, run: cleanup });
        },
      };
    },
    async close() {
      closing = true;
      return closeOwner();
    },
    closeOwner,
  };
}
