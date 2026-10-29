import assert from 'node:assert/strict';
import test from 'node:test';
import { readBuildSnapshot, fullValue, evaluateRun } from './result.mjs';
import {
  fields,
  propertyKeys,
  detectorIds,
  phaseNames,
  injectedPhases,
  profilesFromFingerprint,
  observe,
  sdk,
  packageName,
  eventCode,
} from './spec.mjs';

const row = (label, value, detail = null) => ({ label, value, detail });
const block = (title, rows) => ({ title, type: 'rows', rows });
function fixture() {
  const baseFields = Object.fromEntries(Object.keys(fields).map(key => [key, 'original-' + key]));
  Object.assign(baseFields, {
    MODEL: 'OriginalEmulator',
    TYPE: 'userdebug',
    TAGS: 'test-keys',
    FINGERPRINT: 'Sample/demo/device:13/Build33/42:userdebug/test-keys',
  });
  const baseProperties = Object.fromEntries(
    Object.entries(fields).map(([name, [, key]]) => [key, baseFields[name]])
  );
  Object.assign(baseProperties, {
    'ro.build.flavor': 'demo-userdebug',
    'ro.debuggable': '1',
    'ro.secure': '1',
    'ro.adb.secure': '0',
    'service.adb.root': '1',
  });
  const profiles = profilesFromFingerprint(baseFields.FINGERPRINT);
  const reportRow = (key, value) =>
    row(
      key,
      value.length > 20 ? value.slice(0, 10) + '…' : value,
      'Original value\nSource: Build constant\nObserved: ' + value
    );
  const run = {
    agentSource: 'production-artifact',
    apiAgentSha256: 'a'.repeat(64),
    scriptSha256: 'b'.repeat(64),
    productionManifest: {
      production: true,
      schemaVersion: 2,
      files: { 'dist/android-api.js': 'a'.repeat(64) },
    },
    profiles,
    errors: [],
    cleanup: { complete: true },
    toolStatus: 'passed',
    finalInstallation: {
      buildFields: Object.fromEntries(Object.keys(fields).map(key => [key, { restored: true }])),
    },
    phases: {},
  };
  for (const [index, name] of phaseNames.entries()) {
    const policy = injectedPhases.includes(name) ? (profiles[name] ?? observe) : undefined;
    const actualFields = { ...baseFields, ...policy?.rules?.buildFields };
    const properties = { ...baseProperties, ...policy?.rules?.properties };
    const critical =
      name === 'combined'
        ? 4
        : name === 'properties-only'
          ? 6
          : name === 'inconsistent'
            ? 5
            : name === 'fields-only'
              ? 7
              : 10;
    const buildRows = ['TYPE', 'TAGS', 'FINGERPRINT'].map(key =>
      reportRow('Build.' + key, actualFields[key])
    );
    buildRows.push(
      ...['ro.build.type', 'ro.build.tags', 'ro.build.flavor'].map(key =>
        reportRow(key, properties[key])
      )
    );
    const consistency =
      name === 'inconsistent'
        ? ['ro.build.tags <> Build.TAGS', 'Build.TAGS <> fingerprint tail'].map(key =>
            row(key, 'Drift')
          )
        : [];
    const info = Object.entries(properties)
      .filter(
        ([key]) =>
          ![
            'ro.build.type',
            'ro.build.tags',
            'ro.build.flavor',
            'ro.debuggable',
            'ro.secure',
            'ro.adb.secure',
            'service.adb.root',
          ].includes(key)
      )
      .map(([key, value]) =>
        row(
          'Info ' + key,
          value.length > 20 ? 'truncated…' : value,
          key + '\nSource: Reflection\n' + value
        )
      );
    const virtualBuild =
      actualFields.MODEL === baseFields.MODEL
        ? [row('Build.MODEL', 'emulator', 'Original positive finding')]
        : [];
    const scan = {
      sdk: { tag: sdk.tag, commit: sdk.commit, aarSha256: sdk.sha256 },
      scanId: 'synthetic-' + index,
      pid: name === 'cold' ? 456 : 123,
      apiLevel: 33,
      abis: ['x86_64'],
      startedAtMillis: index * 10,
      finishedAtMillis: index * 10 + 1,
      host: {
        app: { packageName, targetSdk: 33 },
        launchCapture: { intentExtraKeys: ['early_detection_has_run'] },
        mountSampler: { attached: true },
      },
      requestedDetectorIds: detectorIds,
      executedDetectorIds: detectorIds,
      reportText: 'Original synthetic full report',
      results: [
        {
          id: 'system_properties',
          status: { severity: 'DANGER', infoKind: null },
          report: {
            title: 'System Properties',
            severity: 'DANGER',
            verdict: critical + ' high-risk signals',
            quickFacts: [row('Critical', String(critical)), row('Review', '2')],
            blocks: [
              block(
                'Core',
                ['ro.debuggable', 'ro.secure', 'ro.adb.secure', 'service.adb.root'].map(key =>
                  row(key, properties[key])
                )
              ),
              block('Boot', [row('boot', 'unchanged')]),
              block('Build', buildRows),
              block('Source', []),
              block('Consistency', consistency),
              block('Info', info),
              block('Methods', [row('Native', 'Loaded')]),
              block(
                'Scan',
                ['Reflection hits', 'getprop hits', 'Native hits']
                  .map(key => row(key, '100'))
                  .concat([row('Source mismatches', '0'), row('Cross-checks', '0')])
              ),
            ],
          },
        },
        {
          id: 'virtualization',
          status: { severity: 'DANGER', infoKind: null },
          report: {
            title: 'Virtualization',
            severity: 'DANGER',
            verdict: 'Other unmodified signals remain',
            quickFacts: [row('Native', 'Loaded')],
            blocks: [
              block('Environment', [
                ...virtualBuild,
                row('Hardware', 'native original'),
                row('Hardware', 'helper original'),
              ]),
              ...['Runtime', 'Consistency', 'Honeypot', 'Host apps'].map(key => block(key, [])),
              block('Methods', [row('Properties and build', 'Checked')]),
              block(
                'Scan',
                [
                  'Startup preload',
                  'Preload context',
                  'Cross-process helper',
                  'Isolated helper',
                  'EGL renderer',
                  'Mount namespace',
                ].map(key => row(key, key === 'Preload context' ? 'Yes' : 'Ready'))
              ),
            ],
          },
        },
      ],
    };
    const phase = {
      pid: scan.pid,
      policy,
      response: { status: 'succeeded', eventCode, result: scan },
      controls: {
        sdk: '33',
        sdkDefault: '33',
        missingDefault: 'control-default',
        ownPackage: packageName,
        fileExists: true,
        missingRuntime: true,
        missingBuilder: true,
        runtime: { stdout: 'control-out', stderr: 'control-error', exitCode: 7 },
        builder: { stdout: 'control-out', stderr: 'control-error', exitCode: 7 },
        fields: actualFields,
        properties,
        unrelated: { release: '13', id: 'Build33', incremental: '42', api: 33, abis: ['x86_64'] },
      },
      records: [],
      dropped: 0,
      controlObservations: { records: [], dropped: 0 },
      configuration: { buildFields: {} },
    };
    if (policy) {
      const caller = {
        stack: [
          'com.eltavine.duckdetector.capability.systemproperties.data.SystemPropertyReadUtils.read',
        ],
      };
      const native = { module: 'libduckdetector.so' };
      const text = values =>
        propertyKeys.map(key => '[' + key + ']: [' + values[key] + ']\n').join('') +
        '[unrelated]: [unchanged]\n';
      phase.records.push({
        api: 'ProcessBuilder.start',
        args: { argv: ['getprop'] },
        caller,
        original: { stdout: text(baseProperties), exitCode: 0 },
        result: policy.rules?.properties
          ? { stdout: text(properties), exitCode: 0 }
          : 'real-process',
      });
      for (const key of ['ro.build.type', 'ro.build.tags', 'ro.build.fingerprint']) {
        phase.records.push(
          { api: 'SystemProperties.get(1)', args: { key }, caller, result: properties[key] },
          {
            api: 'libc.__system_property_find',
            args: { key },
            caller: native,
            result: { found: true },
          },
          {
            api: 'libc.__system_property_read_callback',
            args: { key },
            caller: native,
            result: properties[key],
          }
        );
      }
      if (index >= 3) {
        phase.configuration.buildFields = Object.fromEntries(
          Object.keys(fields).map(key => [
            key,
            {
              original: baseFields[key],
              requested: actualFields[key],
              current: actualFields[key],
              restored: actualFields[key] === baseFields[key],
            },
          ])
        );
      }
    }
    run.phases[name] = phase;
  }
  return run;
}

test('complete original dual-detector reports pass with DANGER retained and inconsistent control detected', () => {
  const run = fixture();
  assert.deepEqual(evaluateRun(run).failures, []);
  assert.equal(readBuildSnapshot(run.phases.combined.response).virtual.status.severity, 'DANGER');
  assert.equal(
    profilesFromFingerprint('Example/product/device:13/ABC/123:userdebug/test-keys').combined.rules
      .buildFields.FINGERPRINT,
    'AgentForge/af_lab_x64/af_lab_x64:13/ABC/123:user/release-keys'
  );
});

test('full detail is used for long values; incomplete fingerprints and duplicate values fail', () => {
  assert.equal(
    fullValue(row('fingerprint', 'short…', 'Source: Reflection\nUnicode 完整 value')),
    'Unicode 完整 value'
  );
  assert.throws(() => fullValue(row('fingerprint', 'short…')), /complete detail/);
  for (const value of ['', 'partial', 'x/y/z:14/id/1:user/release-keys']) {
    assert.throws(() => profilesFromFingerprint(value), /complete/);
  }
  const run = fixture();
  const build = run.phases.baseline.response.result.results[0].report.blocks.find(
    block => block.title === 'Build'
  );
  build.rows.push(build.rows[0]);
  assert.throws(() => readBuildSnapshot(run.phases.baseline.response), /duplicate/);
});

test('changed readbacks cannot substitute for SDK changes, real sources, complete results or recovery', () => {
  const mutations = [
    run => {
      run.phases.combined.response.result.results[0].report.quickFacts[0].value = '6';
    },
    run => {
      run.phases.combined.records[1].caller = { stack: ['private probe'] };
    },
    run => {
      run.phases.combined.records[3].caller = { module: 'libunrelated.so' };
    },
    run => {
      run.phases.combined.dropped = 1;
    },
    run => {
      run.phases.combined.controls.properties['ro.product.name'] = 'wrong';
    },
    run => {
      run.phases.combined.configuration.buildFields.MODEL.current = 'wrong';
    },
    run => {
      run.phases['after-unload-2'].response.result.results[0].report.quickFacts[0].value = '8';
    },
    run => {
      run.phases.inconsistent.response.result.results[0].report.blocks.find(
        block => block.title === 'Consistency'
      ).rows = [];
    },
    run => {
      run.phases.combined.response.result.results[1].status = {
        severity: 'INFO',
        infoKind: 'ERROR',
      };
    },
    run => {
      run.phases.combined.response.result.results.pop();
    },
    run => {
      run.finalInstallation.buildFields.MODEL.restored = false;
    },
    run => {
      run.cleanup.complete = false;
    },
    run => {
      run.toolStatus = 'failed';
    },
    run => {
      run.scriptSha256 = 'missing';
    },
    run => {
      run.productionManifest.files['dist/android-api.js'] = 'c'.repeat(64);
    },
    run => {
      run.profiles.combined.rules.buildFields.MODEL = 'unexpected';
    },
  ];
  for (const mutate of mutations) {
    const run = fixture();
    mutate(run);
    assert.equal(evaluateRun(run).passed, false, mutate.toString());
  }
});
