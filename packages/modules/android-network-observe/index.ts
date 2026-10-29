import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';

import { meta as sslBypass } from './ssl-bypass';
import { meta as httpTracer } from './http-tracer';

async function activate(ctx: Ctx) {
  const moduleLog = makeModuleLogger('network-observe');

  moduleLog('Activating network observation strategies');

  await sslBypass.activate(ctx);
  await httpTracer.activate(ctx);

  moduleLog('Network observation strategies activated');
}

export const meta: ModuleMeta = {
  id: 'android/network-observe',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: [
      'network-observe',
      'http',
      'network',
      'trace',
      'ssl',
      'https',
      'certificate',
      'comprehensive',
    ],
  },
  priority: 15,
  activate,
};
