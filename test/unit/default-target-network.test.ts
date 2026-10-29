import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const fridaRoot = path.resolve(import.meta.dirname, '..', '..');
const defaultTargetPath = path.join(fridaRoot, 'configs', 'targets', 'default.json');

test('default target keeps stronger packet-capture flags enabled', () => {
  const cfg = JSON.parse(fs.readFileSync(defaultTargetPath, 'utf8'));

  assert.ok(Array.isArray(cfg.enable), 'enable must be an array');
  assert.ok(cfg.enable.includes('http'));
  assert.equal(cfg.flags['http.captureHeaders'], true);
  assert.equal(cfg.flags['http.captureResponseHeaders'], true);
  assert.equal(cfg.flags['http.captureBodyMeta'], true);
  assert.equal(cfg.flags['http.captureBody'], false);
});
