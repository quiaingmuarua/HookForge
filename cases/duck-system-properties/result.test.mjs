import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRun, readSnapshot, renderReport } from './result.mjs';
import { sdk, keys, packageName, eventCode, phaseNames, risk, normal, observe } from './spec.mjs';

const row = (label, value) => ({ label, value, detail: null });
const controls = () => ({
  sdk: '33',
  sdkDefault: '33',
  missingDefault: 'control-default',
  ownPackage: packageName,
  fileExists: true,
  missingRuntime: true,
  missingBuilder: true,
  runtime: { stdout: 'control-out', stderr: 'control-error', exitCode: 7 },
  builder: { stdout: 'control-out', stderr: 'control-error', exitCode: 7 },
});

// Small synthetic reports only; real device exports stay in .runtime.
export function fixture() {
  const base = {
    'ro.debuggable': '1',
    'ro.secure': '1',
    'ro.adb.secure': '0',
    'service.adb.root': '1',
  };
  const run = {
    agentSource: 'production-artifact',
    apiAgentSha256: 'a'.repeat(64),
    scriptSha256: 'b'.repeat(64),
    errors: [],
    cleanup: { complete: true },
    phases: {},
    productionManifest: {
      schemaVersion: 2,
      production: true,
      files: { 'dist/android-api.js': 'a'.repeat(64) },
    },
  };
  for (const [index, name] of phaseNames.entries()) {
    const policy =
      name === 'risk'
        ? risk
        : name === 'normal'
          ? normal
          : ['observe', 'restored'].includes(name)
            ? observe
            : undefined;
    const values =
      name === 'risk' ? risk.rules.properties : name === 'normal' ? normal.rules.properties : base;
    const critical = name === 'risk' ? 8 : name === 'normal' ? 4 : 7;
    const rows = {
      Core: [...keys.map(key => row(key, values[key])), row('other', 'unchanged')],
      Boot: [row('boot', 'unchanged')],
      Build: [row('Build.TYPE', 'userdebug')],
      Source: [],
      Consistency: [],
      Info: [row('ro.product.model', 'synthetic')],
      Methods: [row('Prop area mtimes', 'varies-' + index)],
      Scan: ['Reflection hits', 'getprop hits', 'Native hits']
        .map(label => row(label, '27'))
        .concat([row('Source mismatches', '0'), row('Cross-checks', '0')]),
    };
    const phase = {
      pid: name === 'cold' ? 456 : 123,
      policy,
      controls: controls(),
      dropped: 0,
      records: [],
    };
    phase.response = {
      status: 'succeeded',
      eventCode,
      diagnosticCode: '',
      result: {
        sdk: { tag: sdk.tag, commit: sdk.commit, aarSha256: sdk.sha256 },
        scanId: 'synthetic-' + index,
        pid: phase.pid,
        apiLevel: 33,
        abis: ['x86_64'],
        startedAtMillis: index * 10,
        finishedAtMillis: index * 10 + 1,
        host: {
          app: { packageName, targetSdk: 33 },
          launchCapture: { intentExtraKeys: ['early_detection_has_run'] },
          mountSampler: { attached: true },
        },
        requestedDetectorIds: ['system_properties'],
        executedDetectorIds: ['system_properties'],
        reportText: 'Synthetic original report',
        results: [
          {
            id: 'system_properties',
            status: { severity: 'DANGER', infoKind: null },
            report: {
              title: 'System Properties',
              severity: 'DANGER',
              verdict: critical + ' high-risk property or coherence signal(s)',
              quickFacts: [
                row('Critical', String(critical)),
                row('Review', '2'),
                row('Boot', 'Clean'),
                row('Build', '5'),
              ],
              blocks: Object.entries(rows).map(([title, rows]) => ({ title, type: 'rows', rows })),
            },
          },
        ],
      },
    };
    if (policy) {
      const java = {
        stack: [
          'com.eltavine.duckdetector.capability.systemproperties.data.SystemPropertyReadUtils.readViaReflection',
        ],
      };
      const native = { module: 'libduckdetector.so', address: '0x1234' };
      const text = input =>
        keys.map(key => '[' + key + ']: [' + input[key] + ']\n').join('') +
        '[other]: [untouched]\n';
      phase.records.push({
        api: 'ProcessBuilder.start',
        args: { argv: ['getprop'] },
        caller: java,
        original: { stdout: text(base), exitCode: 0 },
        result: { stdout: text(values), exitCode: 0 },
      });
      if (policy.mode === 'observe') {
        delete phase.records[0].original;
        phase.records[0].result = 'real-process';
      }
      for (const key of keys) {
        phase.records.push(
          {
            api: 'SystemProperties.get(1)',
            args: { key },
            original: base[key],
            result: values[key],
            caller: java,
          },
          {
            api: 'libc.__system_property_read_callback',
            args: { key },
            original: base[key],
            result: values[key],
            caller: native,
          },
          {
            api: 'libc.__system_property_find',
            args: { key },
            result: { found: true },
            caller: native,
          }
        );
      }
    }
    run.phases[name] = phase;
  }
  return run;
}

test('complete original SDK behavior can pass while the aggregate remains DANGER', () => {
  const run = fixture();
  run.evaluation = evaluateRun(run);
  assert.deepEqual(run.evaluation.failures, []);
  assert.equal(run.evaluation.passed, true);
  assert.match(renderReport(run), /normal.*4.*DANGER/);
});

test('missing, malformed, errored, duplicated or unavailable evidence cannot be negative', () => {
  const mutations = [
    run => {
      delete run.phases.normal.response.result.results;
    },
    run => {
      run.phases.normal.response.result.results[0].status = { severity: 'INFO', infoKind: 'ERROR' };
    },
    run => {
      run.phases.normal.response.result.results[0].report.blocks
        .find(block => block.title === 'Core')
        .rows.pop();
      run.phases.normal.response.result.results[0].report.blocks
        .find(block => block.title === 'Core')
        .rows.shift();
    },
    run => {
      const report = run.phases.normal.response.result.results[0].report;
      report.quickFacts.push(report.quickFacts[0]);
    },
    run => {
      run.phases.normal.dropped = 1;
    },
    run => {
      run.phases.normal.records.push({ api: 'test', error: 'command failed' });
    },
    run => {
      run.phases.normal.response.result.scanId = run.phases.risk.response.result.scanId;
    },
    run => {
      run.phases.normal.response.result.results[0].report.blocks.find(
        block => block.title === 'Scan'
      ).rows[2].value = '0';
    },
    run => {
      run.phases.normal.response.result.results[0].report.quickFacts[0].value = '8';
    },
    run => {
      run.cleanup.complete = false;
    },
    run => {
      run.productionManifest.files['dist/android-api.js'] = 'f'.repeat(64);
    },
    run => {
      run.phases.observe.records = [];
    },
  ];
  for (const mutate of mutations) {
    const run = fixture();
    mutate(run);
    assert.equal(evaluateRun(run).passed, false);
  }
});

test('API caller, configured delivery and unrelated contents are independently required', () => {
  const mutations = [
    run => {
      run.phases.normal.records[0].caller.stack = ['org.agentforge.control'];
    },
    run => {
      run.phases.normal.records.find(item => item.api.endsWith('read_callback')).caller.module =
        'libandroid_runtime.so';
    },
    run => {
      run.phases.normal.records.find(item => item.api.startsWith('SystemProperties')).result =
        'wrong';
    },
    run => {
      run.phases.normal.records[0].result.stdout += '[extra]: [inserted]\n';
    },
    run => {
      run.phases.normal.records[0].result.exitCode = 1;
    },
    run => {
      run.phases.normal.controls.builder.exitCode = 0;
    },
    run => {
      run.phases.normal.policy = risk;
    },
    run => {
      run.phases.normal.response.result.results[0].report.blocks
        .find(block => block.title === 'Source')
        .rows.push(row('ro.secure', 'Diverged'));
    },
  ];
  for (const mutate of mutations) {
    const run = fixture();
    mutate(run);
    assert.equal(evaluateRun(run).passed, false);
  }
});

test('restoration requires original values, same process after unload and a fresh cold process', () => {
  for (const name of ['observe', 'restored', 'after-unload-1', 'after-unload-2', 'cold']) {
    const run = fixture();
    run.phases[name].response.result.results[0].report.blocks.find(
      block => block.title === 'Core'
    ).rows[0].value = '0';
    assert.equal(evaluateRun(run).passed, false, name);
  }
  for (const name of ['after-unload-1', 'after-unload-2']) {
    const run = fixture();
    run.phases[name].pid = run.phases[name].response.result.pid = 789;
    assert.equal(evaluateRun(run).passed, false);
  }
  const run = fixture();
  run.phases.cold.pid = run.phases.cold.response.result.pid = 123;
  assert.equal(evaluateRun(run).passed, false);
});

test('empty Source mapping is valid; missing or damaged mappings fail closed', () => {
  const response = fixture().phases.baseline.response;
  assert.equal(readSnapshot(response).rows.Source.size, 0);
  response.result.results[0].report.blocks.find(block => block.title === 'Source').rows = null;
  assert.throws(() => readSnapshot(response), /missing/);
});
