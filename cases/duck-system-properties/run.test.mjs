import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { options, outputDirectory, preflight, mainActivityReady } from './run.mjs';

test('startup waits for the actual resumed main Activity after NativeActivity', () => {
  for (const prefix of ['mResumedActivity:', 'ResumedActivity:', 'topResumedActivity=']) {
    assert.equal(
      mainActivityReady(
        prefix + 'ActivityRecord{123 u0 com.detect.app.sample/.DetectEnvMainActivity}'
      ),
      true
    );
  }
  assert.equal(
    mainActivityReady(
      'ResumedActivity: ActivityRecord{com.detect.app.sample/android.app.NativeActivity}'
    ),
    false
  );
  assert.equal(
    mainActivityReady(
      'mLastPausedActivity: ActivityRecord{com.detect.app.sample/.DetectEnvMainActivity}'
    ),
    false
  );
});

test('runner resolves caller-relative inputs and enforces its production pair before execution', () => {
  const base = ['--apk', 'test.apk', '--serial', 'emulator-5554'];
  assert.equal(options(base, os.tmpdir()).apk, path.join(os.tmpdir(), 'test.apk'));
  for (const extra of [
    ['--agent', 'agent.js'],
    ['--production-manifest', 'manifest.json'],
    ['--serial', 'duplicate'],
    ['--unexpected', 'value'],
  ]) {
    assert.throws(() => options([...base, ...extra]));
  }
  const value = options([...base, '--agent', 'agent.js', '--production-manifest', 'manifest.json']);
  assert.equal(value.serial, 'emulator-5554');
  assert.ok(path.isAbsolute(value.agent));
  assert.throws(() => options(['--apk', 'missing-serial']));
});

test('output directory cannot overwrite existing evidence, including an empty directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = outputDirectory(path.join(root, 'run'));
  assert.throws(() => outputDirectory(output), { code: 'EEXIST' });
  fs.writeFileSync(path.join(output, 'keep'), 'evidence');
  assert.throws(() => outputDirectory(output), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'evidence');
});

test('production verification precedes even reading the APK; invalid manifests cannot reach ADB', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, '{}');
  assert.throws(
    () =>
      preflight({
        apk: path.join(root, 'missing.apk'),
        agent: path.join(root, 'missing.js'),
        'production-manifest': manifest,
      }),
    /Production artifact verification failed/
  );
  const apk = path.join(root, 'not-an-apk');
  fs.writeFileSync(apk, 'broken');
  assert.throws(() => preflight({ apk }), /Invalid APK/);
});
