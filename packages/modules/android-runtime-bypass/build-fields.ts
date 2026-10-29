import type { BuildField } from './api-policy';

export type FieldReceipt = {
  original: string | null;
  requested: string | null;
  current: string | null;
  restored: boolean;
  changed: boolean;
};

/** State owned by the public API instance; all calls run inside performOnJava. */
export function createBuildFieldOwner(Build: any) {
  const originals = new Map<BuildField, string | null>();
  const receipts: Partial<Record<BuildField, FieldReceipt>> = {};
  const read = (name: BuildField): string | null => {
    const value = Build[name].value;
    return value === null || value === undefined ? null : String(value);
  };
  function write(name: BuildField, requested: string | null) {
    const original = originals.get(name)!;
    Build[name].value = requested;
    const current = read(name);
    receipts[name] = {
      original,
      requested,
      current,
      restored: current === original,
      changed: current !== original,
    };
    if (current !== requested) {
      throw new Error('Build.' + name + ' readback differs from requested value');
    }
  }
  function restore() {
    const failures: string[] = [];
    for (const [name, original] of originals) {
      try {
        write(name, original);
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (failures.length) {
      throw new Error('Build field restoration failed: ' + failures.join('; '));
    }
  }
  return {
    apply(requested: Partial<Record<BuildField, string>>) {
      try {
        restore();
        for (const [name, value] of Object.entries(requested) as [BuildField, string][]) {
          if (!originals.has(name)) {
            originals.set(name, read(name));
          }
          write(name, value);
        }
      } catch (error) {
        try {
          restore();
        } catch (rollback) {
          throw new Error(String(error) + '; rollback: ' + rollback);
        }
        throw error;
      }
    },
    restore,
    snapshot: () =>
      JSON.parse(JSON.stringify(receipts)) as Partial<Record<BuildField, FieldReceipt>>,
  };
}
