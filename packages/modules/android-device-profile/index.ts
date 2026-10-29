import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';

import { meta as infoCollector } from './info-collector';
import { meta as simCollector } from './sim-collector';
import { meta as deviceFingerprint } from './device-fingerprint';
import { meta as buildSpoof } from './build-spoof';

function shouldActivateStrategy(strategy: ModuleMeta, ctx: Ctx): boolean {
  const enabledTags = new Set(ctx.cfg.enable || []);
  const strategyTags = strategy.selector.tags || [];

  if (enabledTags.size === 0 || strategyTags.length === 0) {
    return true;
  }

  return strategyTags.some(tag => enabledTags.has(tag));
}

async function activate(ctx: Ctx) {
  const moduleLog = makeModuleLogger('device-profile');
  const strategies = [
    infoCollector,
    simCollector,
    buildSpoof,
    deviceFingerprint,
  ] satisfies ModuleMeta[];
  const selectedStrategies = strategies.filter(strategy => shouldActivateStrategy(strategy, ctx));
  let activatedCount = 0;
  let failedCount = 0;

  if (selectedStrategies.length === 0) {
    moduleLog('No device profile strategies matched the enabled tags');
    return;
  }

  moduleLog(
    'Activating device profile strategies: %s',
    selectedStrategies.map(strategy => strategy.id).join(', ')
  );

  for (const strategy of selectedStrategies) {
    try {
      await strategy.activate(ctx);
      activatedCount++;
    } catch (e) {
      failedCount++;
      moduleLog(
        'Device profile strategy failed: %s -> %s',
        strategy.id,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  moduleLog(
    'Device profile strategies finished: %d activated, %d failed',
    activatedCount,
    failedCount
  );
}

export const meta: ModuleMeta = {
  id: 'android/device-profile',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: [
      'device-profile',
      'fingerprint',
      'device',
      'info',
      'sim',
      'telephony',
      'build-spoof',
      'collector',
      'privacy',
      'enumeration',
      'spoof',
    ],
  },
  priority: 10,
  activate,
};
