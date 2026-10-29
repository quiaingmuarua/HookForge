import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fridaRoot = path.resolve(import.meta.dirname, '..', '..');
const detectTargetPath = path.join(fridaRoot, 'configs', 'targets', 'detect-app-sample.json');

test('detect-app-sample target config stays aligned with DetectApp integration usage', () => {
  const cfg = JSON.parse(fs.readFileSync(detectTargetPath, 'utf8'));

  assert.ok(Array.isArray(cfg.enable), 'enable must be an array');
  assert.ok(cfg.enable.includes('fingerprint'));
  assert.ok(cfg.enable.includes('device'));
  assert.ok(cfg.enable.includes('build-spoof'));
  assert.equal(cfg.flags['validator.enabled'], true);
  assert.equal(cfg.flags['validator.detectApp'], true);
});
