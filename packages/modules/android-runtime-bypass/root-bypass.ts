import { Ctx, ModuleMeta } from '@core/types';
import { AndroidApiPolicy } from './api-policy';

import rootPolicy from './root-policy.json';
import { androidApi } from './api-runtime';
let release: (() => Promise<void>) | undefined;
async function activate(ctx: Ctx) {
  if (release) {
    throw new Error('Root policy already active');
  }
  const lease = await androidApi.acquire(
    (ctx.cfg.flags?.['android.api'] ?? rootPolicy) as AndroidApiPolicy
  );
  release = lease.release;
  ctx.log('Shared Android API root policy active');
}
async function deactivate() {
  if (release) {
    await release();
    release = undefined;
  }
}

export const meta: ModuleMeta = {
  id: 'android/root-bypass',
  selector: { platform: 'android', layer: 'java', tags: ['bypass', 'root', 'detection'] },
  priority: 20,
  activate,
  deactivate,
};
