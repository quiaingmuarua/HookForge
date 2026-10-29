import { ModuleMeta } from '../packages/core/types';

import { meta as androidRuntimeBypass } from '../packages/modules/android-runtime-bypass/index';
import { meta as androidDeviceProfile } from '../packages/modules/android-device-profile/index';
import { meta as androidNetworkObserve } from '../packages/modules/android-network-observe/index';
import { meta as androidValidation } from '../packages/modules/android-validation/index';

/**
 * Stable top-level capability registry.
 *
 * Keep the registry intentionally small. Fine-grained hook strategies should live
 * inside capability modules rather than growing the number of top-level modules.
 */
export const REGISTRY: ModuleMeta[] = [
  androidRuntimeBypass,
  androidDeviceProfile,
  androidNetworkObserve,
  androidValidation,
];

export function getModulesByTag(tag: string): ModuleMeta[] {
  return REGISTRY.filter(module => module.selector.tags?.includes(tag));
}

export function getModulesByPlatform(platform: 'android' | 'ios'): ModuleMeta[] {
  return REGISTRY.filter(
    module => !module.selector.platform || module.selector.platform === platform
  );
}

export function getAllTags(): string[] {
  const tags = new Set<string>();
  REGISTRY.forEach(module => {
    module.selector.tags?.forEach(tag => tags.add(tag));
  });
  return Array.from(tags).sort();
}

export function getModuleStats() {
  return {
    total: REGISTRY.length,
    android: getModulesByPlatform('android').length,
    ios: getModulesByPlatform('ios').length,
    cross_platform: REGISTRY.filter(m => !m.selector.platform).length,
    tags: getAllTags(),
  };
}
