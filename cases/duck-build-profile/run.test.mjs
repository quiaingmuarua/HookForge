import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from './run.mjs';
import { parseComposition } from '../../hosts/node-cli/run.js';

test('case entry rejects incomplete inputs and advertises its own command before device work', () => {
  const file = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [file, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /case:duck-build-profile/);
  const invalid = spawnSync(
    process.execPath,
    [file, '--apk', 'missing.apk', '--serial', 's', '--agent', 'unpaired'],
    { encoding: 'utf8' }
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /supplied together/);
});

test('production provenance failure and existing output are rejected before a session can operate', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-build-input-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = path.join(directory, 'manifest.json');
  fs.writeFileSync(manifest, '{}');
  await assert.rejects(
    main({
      apk: path.join(directory, 'missing.apk'),
      serial: 's',
      agent: path.join(directory, 'missing.js'),
      'production-manifest': manifest,
      output: path.join(directory, 'never-created'),
    }),
    /Production artifact verification failed/
  );
  assert.equal(fs.existsSync(path.join(directory, 'never-created')), false);
  assert.throws(
    () => parseComposition(['run', '--serial', 's', '--attach', 'p', '--output', directory]),
    /already exists/
  );
  assert.equal(fs.readFileSync(manifest, 'utf8'), '{}');
});
