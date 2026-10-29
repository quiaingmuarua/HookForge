import type { ExtensionContext } from '../../packages/composition/types';
import profile from './normal.json';

// Only standard libc APIs. This never calls or hooks an SDK/detector entry.
export function activate(_ctx: ExtensionContext) {
  const get = new NativeFunction(Module.getGlobalExportByName('__system_property_get'), 'int', [
    'pointer',
    'pointer',
  ]);
  const find = new NativeFunction(
    Module.getGlobalExportByName('__system_property_find'),
    'pointer',
    ['pointer']
  );
  rpc.exports.casecontrols = () => {
    const read = (key: string) => {
      const name = Memory.allocUtf8String(key);
      const buffer = Memory.alloc(92);
      const length = Number(get(name, buffer));
      return { found: !find(name).isNull(), value: buffer.readCString(), length };
    };
    return {
      pid: Process.id,
      arch: Process.arch,
      properties: Object.fromEntries(
        Object.keys(profile.rules.properties).map(key => [key, read(key)])
      ),
      unrelated: Object.fromEntries(
        ['ro.product.cpu.abilist', 'ro.build.version.sdk', 'ro.build.version.release'].map(key => [
          key,
          read(key),
        ])
      ),
    };
  };
  // Keep this read-only diagnostic RPC until Script unload so restoration can
  // be measured after dispose. It owns no hooks, callback wrappers or SDK state.
  return () => {};
}
