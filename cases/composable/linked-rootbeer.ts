import type { ExtensionContext } from '../../packages/composition/types';
import { installUiAdapter } from '../rootbeer/ui-adapter';

export async function activate(ctx: ExtensionContext) {
  const restore = installUiAdapter(value => ctx.emit('rootbeer-results', value));
  ctx.scope.defer(async () => {
    await rpc.exports.disposeobserver();
    restore();
  });
  ctx.emit('rootbeer-observer-ready', await rpc.exports.init());
  return () => {};
}
