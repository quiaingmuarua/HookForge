import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyFixture } from '../../scripts/fixture.mjs';

test('fixed APK bytes are required; a missing or changed fixture fails before installation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hookforge-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const apk = path.join(directory, 'detect-env.apk');
  const bytes = Buffer.from('synthetic APK bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const expected = { sha256 } as Parameters<typeof verifyFixture>[1];
  assert.throws(() => verifyFixture(apk, expected), /ENOENT/);
  fs.writeFileSync(apk, bytes);
  assert.equal(verifyFixture(apk, expected), sha256);
  fs.appendFileSync(apk, 'changed');
  assert.throws(() => verifyFixture(apk, expected), /checksum mismatch/);
});
