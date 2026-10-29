import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';

import { meta as rootBypass } from './root-bypass';

async function activate(ctx: Ctx) {
  const moduleLog = makeModuleLogger('runtime-bypass');

  moduleLog('Activating runtime bypass strategies');

  await rootBypass.activate(ctx);

  moduleLog('Runtime bypass strategies activated');
}

export const meta: ModuleMeta = {
  id: 'android/runtime-bypass',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['runtime-bypass', 'bypass', 'root', 'detection', 'stealth'],
  },
  priority: 20,
  activate,
  deactivate: ctx => rootBypass.deactivate?.(ctx),
};
