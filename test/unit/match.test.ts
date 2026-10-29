import test from 'node:test';
import assert from 'node:assert/strict';

import { selectModules } from '../../packages/core/match';
import type { Env, ModuleMeta, TargetConfig } from '../../packages/core/types';

const baseEnv: Env = {
  platform: 'android',
  appId: 'com.detect.app.sample',
  appVer: '1.0',
  arch: 'arm64',
  javaAvailable: true,
  objcAvailable: false,
};

test('selectModules filters by selector and sorts by priority descending', () => {
  const modules: ModuleMeta[] = [
    {
      id: 'android/http',
      selector: { platform: 'android', layer: 'java', tags: ['http'] },
      priority: 1,
      activate: () => {},
    },
    {
      id: 'android/fingerprint',
      selector: { platform: 'android', layer: 'java', tags: ['fingerprint'] },
      priority: 10,
      activate: () => {},
    },
    {
      id: 'ios/objc',
      selector: { platform: 'ios', layer: 'objc', tags: ['http'] },
      priority: 99,
      activate: () => {},
    },
  ];

  const cfg: TargetConfig = {
    enable: ['http', 'fingerprint'],
  };

  const selected = selectModules(modules, baseEnv, cfg);
  assert.deepEqual(
    selected.map(module => module.id),
    ['android/fingerprint', 'android/http']
  );
});

test('selectModules excludes java modules when Java is unavailable', () => {
  const modules: ModuleMeta[] = [
    {
      id: 'android/root-bypass',
      selector: { platform: 'android', layer: 'java', tags: ['bypass'] },
      priority: 5,
      activate: () => {},
    },
  ];

  const cfg: TargetConfig = { enable: ['bypass'] };
  const env: Env = { ...baseEnv, javaAvailable: false };

  const selected = selectModules(modules, env, cfg);
  assert.equal(selected.length, 0);
});

test('selectModules respects appId and appVer constraints', () => {
  const modules: ModuleMeta[] = [
    {
      id: 'android/detect-app',
      selector: {
        platform: 'android',
        layer: 'java',
        tags: ['validation'],
        appId: 'com.detect.app.sample',
        appVer: /^1\./,
      },
      priority: 1,
      activate: () => {},
    },
    {
      id: 'android/other-app',
      selector: {
        platform: 'android',
        layer: 'java',
        tags: ['validation'],
        appId: 'com.other.app',
      },
      priority: 2,
      activate: () => {},
    },
  ];

  const cfg: TargetConfig = { enable: ['validation'] };
  const selected = selectModules(modules, baseEnv, cfg);

  assert.deepEqual(
    selected.map(module => module.id),
    ['android/detect-app']
  );
});
