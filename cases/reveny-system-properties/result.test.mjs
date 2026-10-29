import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { attributes } from './catalog.mjs';
import { evaluateRun } from './result.mjs';
import { readResultUi } from '../../apps/reveny-emulator/host.mjs';

const risk = JSON.parse(fs.readFileSync(new URL('./risk.json', import.meta.url)));
const normal = JSON.parse(fs.readFileSync(new URL('./normal.json', import.meta.url)));
function fixture() {
  const original = Object.fromEntries(attributes.map(([key]) => [key, 'original-' + key]));
  const controls = properties => ({
    pid: 0,
    arch: 'x64',
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        { found: true, value, length: Buffer.byteLength(value) },
      ])
    ),
    unrelated: {
      'ro.product.cpu.abilist': { found: true, value: 'x86_64', length: 6 },
      'ro.build.version.sdk': { found: true, value: '33', length: 2 },
      'ro.build.version.release': { found: true, value: '13', length: 2 },
    },
  });
  const run = { errors: [], cleanup: { complete: true }, apiAgentSha256: 'public', phases: {} };
  let pid = 100;
  for (const name of ['baseline', 'observe', 'risk', 'normal', 'cold']) {
    const policy = name === 'risk' ? risk : name === 'normal' ? normal : { mode: 'observe' };
    const values = policy.rules?.properties ?? original;
    const findings = ['- Detected x86 Architecture'];
    if (name === 'risk') {
      for (const [key, label] of attributes) {
        findings.push('- Detected ' + label + ': ' + values[key]);
      }
    }
    const phase = {
      pid: ++pid,
      ui: { pid, findings },
      policy,
      toolPassed: true,
      instrumentation: ['baseline', 'cold'].includes(name) ? 'none' : 'composition',
    };
    if (phase.instrumentation === 'composition') {
      Object.assign(phase, {
        apiAgentSha256: 'public',
        dropped: 0,
        nativeStartup: { pid, readyAt: 1000, installed: ['libc.__system_property_get'] },
        records: attributes.map(([key]) => ({
          api: 'libc.__system_property_get',
          ts: 1001,
          args: { key, found: true },
          original: original[key],
          result: values[key],
          resultReturn: Buffer.byteLength(values[key]),
          caller: { module: 'libemulatordetector.so' },
        })),
        controls: { ...controls(values), pid },
        restoredControls: { ...controls(original), pid },
        disposedControls: { ...controls(original), pid },
        dispose: { restored: true },
        afterUnload: { pid, findings },
      });
    }
    run.phases[name] = phase;
  }
  return run;
}
test('original findings change while overall detection remains positive; cache and API restoration are separate', () => {
  assert.deepEqual(evaluateRun(fixture()).failures, []);
});
test('API-only changes, late/probe-only calls, corrupt results, different bytes and failed recovery never pass', () => {
  for (const mutate of [
    run => {
      run.phases.risk.ui.findings = ['- Detected x86 Architecture'];
    },
    run => {
      run.phases.risk.records[0].caller.module = 'probe.so';
    },
    run => {
      run.phases.risk.records[0].ts = 999;
    },
    run => {
      run.phases.risk.records[0].runtimeError = true;
    },
    run => {
      run.phases.risk.apiAgentSha256 = 'different';
    },
    run => {
      run.phases.risk.dropped = 1;
    },
    run => {
      run.phases.normal.disposedControls.properties['ro.hardware'].value = 'af_lab_hw';
    },
    run => {
      run.phases.normal.afterUnload.pid = 1;
    },
    run => {
      run.phases.cold.ui.findings.push('- Detected Hardware: goldfish');
    },
    run => {
      run.phases.observe.pid = run.phases.baseline.pid;
    },
    run => {
      run.cleanup.complete = false;
    },
    run => {
      delete run.phases.risk;
    },
    run => {
      run.phases.risk.records = {};
    },
    run => {
      run.phases.risk.ui.findings = {};
    },
    run => {
      run.phases.normal.controls.unrelated = {};
    },
  ]) {
    const run = fixture();
    mutate(run);
    assert.equal(evaluateRun(run).passed, false);
  }
});
test('UI adapter preserves original lines, decodes XML, and rejects incomplete/duplicate results', () => {
  const node =
    '<node resource-id="pkg:id/result_text" text="- Detected Hardware: é&amp;中&#10;- Detected x86 Architecture" />';
  assert.equal(readResultUi(node, 'pkg').findings[0], '- Detected Hardware: é&中');
  assert.deepEqual(
    readResultUi('<node resource-id="pkg:id/result_text" text="Nothing detected!"/>', 'pkg')
      .findings,
    []
  );
  assert.throws(() => readResultUi(node + node, 'pkg'), /one original/);
  assert.throws(
    () => readResultUi('<node resource-id="pkg:id/result_text" text=""/>', 'pkg'),
    /not complete/
  );
});
