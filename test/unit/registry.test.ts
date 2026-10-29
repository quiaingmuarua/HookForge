import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fridaRoot = path.resolve(import.meta.dirname, '..', '..');
const registryPath = path.join(fridaRoot, 'configs', 'registry.ts');

test('registry stays intentionally small and capability-oriented', () => {
  const registrySource = fs.readFileSync(registryPath, 'utf8');

  const capabilityImports = [
    'android-runtime-bypass/index',
    'android-device-profile/index',
    'android-network-observe/index',
    'android-validation/index',
  ];

  capabilityImports.forEach(importPath => {
    assert.match(registrySource, new RegExp(importPath.replace(/\//g, '\\/')));
  });

  assert.match(registrySource, /androidRuntimeBypass/);
  assert.match(registrySource, /androidDeviceProfile/);
  assert.match(registrySource, /androidNetworkObserve/);
  assert.match(registrySource, /androidValidation/);
});
