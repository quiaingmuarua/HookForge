/**
 * stats.mjs
 *
 * Prints module registry stats without importing Frida runtime code.
 * Uses static JSON metadata instead of dynamic import of registry.ts,
 * because registry.ts transitively imports frida-java-bridge which
 * depends on Frida runtime globals (Process, Java, etc.) not present in Node.
 */

const MODULES = [
  {
    id: 'android/runtime-bypass',
    platform: 'android',
    layer: 'java',
    tags: ['runtime-bypass', 'bypass', 'root', 'detection', 'stealth'],
    priority: 20,
  },
  {
    id: 'android/device-profile',
    platform: 'android',
    layer: 'java',
    tags: ['device-profile', 'fingerprint', 'spoof', 'identity'],
    priority: 10,
  },
  {
    id: 'android/network-observe',
    platform: 'android',
    layer: 'java',
    tags: ['network', 'http', 'ssl', 'observe'],
    priority: 5,
  },
  {
    id: 'android/validation',
    platform: 'android',
    layer: 'java',
    tags: ['validation', 'selftest'],
    priority: 1,
  },
];

const allTags = [...new Set(MODULES.flatMap(m => m.tags))].sort();

const stats = {
  total: MODULES.length,
  android: MODULES.filter(m => m.platform === 'android').length,
  ios: MODULES.filter(m => m.platform === 'ios').length,
  cross_platform: MODULES.filter(m => !m.platform).length,
  tags: allTags,
  modules: MODULES.map(m => ({ id: m.id, priority: m.priority, tags: m.tags })),
};

console.log('Modules:', JSON.stringify(stats, null, 2));
