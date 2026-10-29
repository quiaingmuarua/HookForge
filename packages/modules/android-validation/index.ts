import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';

import { meta as spoofValidator } from './spoof-validator';

async function activate(ctx: Ctx) {
  const moduleLog = makeModuleLogger('validation');

  moduleLog('Activating validation strategies');

  await spoofValidator.activate(ctx);

  moduleLog('Validation strategies activated');
}

export const meta: ModuleMeta = {
  id: 'android/validation',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['validation', 'spoof-validator', 'testing', 'spoof'],
  },
  priority: 5,
  activate,
};
