import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';
import { performOnJava } from '@core/java-bridge';

// For existing legacy loader modules. New sample work can stay in apps/<sample>/
// as a standalone script; using this template or registering a module is optional.
async function activate(ctx: Ctx) {
  const { env, log } = ctx;

  if (env.platform !== 'android' || !env.javaAvailable) {
    log('Module skipped: not Android or Java not available');
    return;
  }

  const moduleLog = makeModuleLogger('replace-me');

  await performOnJava(() => {
    // Add hook logic here and let initialization failures reject activation.
    // Add a matching deactivate implementation when hooks need cleanup.
    moduleLog('Module activated');
  });
}

export const meta: ModuleMeta = {
  id: 'android/replace-me',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['replace-me'],
  },
  priority: 1,
  activate,
};
