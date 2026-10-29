import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { options } from '../duck-system-properties/run.mjs';
import { preflight } from './run.mjs';

test('case reuses paired production arguments and rejects invalid input/output before device work', () => {
  assert.throws(() => options(['--apk', 'a', '--serial', 'b', '--agent', 'c']), /together/);
  assert.throws(() => options(['--serial', 'b']), /required/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-reveny-'));
  try {
    const apk = path.join(root, 'wrong.apk');
    fs.writeFileSync(apk, 'not the fixture');
    assert.throws(() => preflight({ apk, output: root }), /new directory/);
    assert.throws(() => preflight({ apk }), /fixed original/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
