import { installUiAdapter } from '../rootbeer/ui-adapter';
import type { ExtensionContext } from '../../packages/composition/types';

export function activate(ctx: ExtensionContext) {
  ctx.scope.own('com.scottyab.rootbeer.sample.MainActivity.animateResults', () => {});
  ctx.scope.own('com.scottyab.rootbeer.sample.MainActivity.onRootCheckFinished', () => {});
  const restore = installUiAdapter();
  return async () => {
    await rpc.exports.disposeobserver();
    restore();
  };
}
