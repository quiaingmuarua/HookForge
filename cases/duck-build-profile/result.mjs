import { isDeepStrictEqual } from 'node:util';
import {
  readSnapshot,
  parseGetprop,
  verifyControls,
  javaCaller,
  nativeCaller,
} from '../duck-system-properties/result.mjs';
import {
  detectorIds,
  fields,
  propertyKeys,
  requiredSources,
  phaseNames,
  injectedPhases,
  profilesFromFingerprint,
  observe,
} from './spec.mjs';

const check = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const equal = (a, b, label) => check(isDeepStrictEqual(a, b), label);
const fieldLabels = Object.keys(fields).map(name => 'Build.' + name);
const mismatchLabels = ['ro.build.tags <> Build.TAGS', 'Build.TAGS <> fingerprint tail'];

export function fullValue(row) {
  check(row && typeof row.value === 'string', 'Required report value missing');
  const observed = (row.detail ?? '').split('\n').filter(line => line.startsWith('Observed: '));
  check(observed.length <= 1, 'Duplicate full observed value');
  if (observed.length) {
    return observed[0].slice('Observed: '.length);
  }
  if (!row.value.includes('…')) {
    return row.value;
  }
  const lines = (row.detail ?? '').split('\n');
  const source = lines.findIndex(line => line.startsWith('Source: '));
  check(
    source >= 0 && lines.length === source + 2 && lines[source + 1].length > 0,
    'Truncated value has no complete detail'
  );
  return lines[source + 1];
}

function reportRows(report, title, unique = true) {
  const blocks = report.blocks.filter(block => block.title === title);
  check(blocks.length === 1 && blocks[0].type === 'rows', title + ' block missing/duplicated');
  const rows = blocks[0].rows;
  if (unique) {
    check(new Set(rows.map(row => row.label)).size === rows.length, title + ' duplicate row');
  }
  return rows;
}

export function readBuildSnapshot(response) {
  const value = readSnapshot(response, detectorIds, true);
  const virtual = value.scan.results.find(item => item.id === 'virtualization');
  check(
    virtual &&
      ['DANGER', 'WARNING', 'ALL_CLEAR', 'INFO'].includes(virtual.status?.severity) &&
      (virtual.status.severity !== 'INFO' || virtual.status.infoKind === 'SUPPORT'),
    'Virtualization error/status missing'
  );
  const report = virtual.report;
  check(
    report &&
      report.severity === virtual.status.severity &&
      typeof report.verdict === 'string' &&
      report.verdict.length > 0 &&
      Array.isArray(report.quickFacts) &&
      Array.isArray(report.blocks),
    'Virtualization report damaged'
  );
  for (const fact of report.quickFacts) {
    check(
      typeof fact?.label === 'string' && typeof fact.value === 'string',
      'Virtualization fact damaged'
    );
  }
  check(
    new Set(report.blocks.map(block => block?.title)).size === report.blocks.length,
    'Virtualization duplicate block'
  );
  for (const block of report.blocks) {
    check(typeof block?.title === 'string', 'Virtualization block damaged');
    if (block.type === 'rows') {
      check(
        Array.isArray(block.rows) &&
          block.rows.every(
            row =>
              typeof row?.label === 'string' &&
              typeof row.value === 'string' &&
              (row.detail === null || typeof row.detail === 'string')
          ),
        'Virtualization rows damaged'
      );
    } else if (block.type === 'bullets') {
      check(
        Array.isArray(block.items) && block.items.every(item => typeof item === 'string'),
        'Virtualization bullets damaged'
      );
    } else if (block.type === 'verbatim') {
      check(
        Array.isArray(block.lines) && block.lines.every(item => typeof item === 'string'),
        'Virtualization verbatim damaged'
      );
    } else {
      throw new Error('Virtualization unknown report block');
    }
  }
  for (const title of [
    'Environment',
    'Runtime',
    'Consistency',
    'Honeypot',
    'Host apps',
    'Methods',
    'Scan',
  ]) {
    reportRows(report, title, !['Environment', 'Runtime', 'Consistency'].includes(title));
  }
  const virtualBuild = reportRows(report, 'Environment', false).filter(row =>
    fieldLabels.includes(row.label)
  );
  check(
    new Set(virtualBuild.map(row => row.label)).size === virtualBuild.length,
    'Duplicate Build finding'
  );
  const virtualScan = Object.fromEntries(
    reportRows(report, 'Scan').map(row => [row.label, row.value])
  );
  for (const key of [
    'Startup preload',
    'Preload context',
    'Cross-process helper',
    'Isolated helper',
    'EGL renderer',
    'Mount namespace',
  ]) {
    check(
      virtualScan[key] === (key === 'Preload context' ? 'Yes' : 'Ready'),
      key + ' coverage unavailable'
    );
  }
  check(
    report.quickFacts.filter(row => row.label === 'Native').length === 1 &&
      report.quickFacts.find(row => row.label === 'Native').value === 'Loaded',
    'Original native library unavailable'
  );
  check(
    reportRows(report, 'Methods').some(
      row => row.label === 'Properties and build' && !/Unavailable|Error|Failed/i.test(row.value)
    ),
    'Original Build method unavailable'
  );

  const reportedFields = Object.fromEntries(
    ['TYPE', 'TAGS', 'FINGERPRINT'].map(name => [
      name,
      fullValue(value.rows.Build.get('Build.' + name)),
    ])
  );
  const reportedProperties = {};
  for (const title of ['Core', 'Build', 'Info']) {
    for (const row of value.rows[title].values()) {
      const key = propertyKeys.includes(row.label) ? row.label : (row.detail ?? '').split('\n')[0];
      if (propertyKeys.includes(key)) {
        check(!Object.hasOwn(reportedProperties, key), 'Duplicate property report value: ' + key);
        reportedProperties[key] = fullValue(row);
      }
    }
  }
  for (const key of requiredSources) {
    check(Object.hasOwn(reportedProperties, key), key + ' SDK value missing');
  }
  const stable = Object.fromEntries(
    ['Core', 'Boot', 'Build', 'Source', 'Consistency', 'Info', 'Scan'].map(title => [
      title,
      [...value.rows[title].values()],
    ])
  );
  const unrelated = Object.fromEntries(
    ['Core', 'Boot', 'Info'].map(title => [
      title,
      [...value.rows[title].values()].filter(
        row =>
          !propertyKeys.includes(row.label) &&
          !propertyKeys.includes((row.detail ?? '').split('\n')[0])
      ),
    ])
  );
  return {
    ...value,
    virtual,
    virtualBuild,
    virtualScan,
    reportedFields,
    reportedProperties,
    stable,
    unrelated,
  };
}

function apiEvidence(phase, expected) {
  check(
    Array.isArray(phase.records) && phase.dropped === 0 && !phase.records.some(row => row.error),
    'SDK API evidence missing/truncated/failed'
  );
  check(
    Array.isArray(phase.controlObservations?.records) &&
      phase.controlObservations.dropped === 0 &&
      !phase.controlObservations.records.some(row => row.runtimeError),
    'Control observations incomplete'
  );
  const commands = phase.records.filter(
    row =>
      row.api === 'ProcessBuilder.start' &&
      javaCaller(row) &&
      row.args?.argv?.length === 1 &&
      ['getprop', '/system/bin/getprop'].includes(row.args.argv[0])
  );
  check(commands.length === 1, 'Original Duck ProcessBuilder getprop missing/duplicated');
  const command = commands[0];
  const rewriting =
    phase.policy.mode === 'replace' && Object.keys(phase.policy.rules?.properties ?? {}).length > 0;
  if (rewriting) {
    check(
      command.original?.exitCode === 0 && command.result?.exitCode === 0,
      'getprop command failed'
    );
    const before = parseGetprop(command.original.stdout);
    const after = parseGetprop(command.result.stdout);
    const strip = text =>
      text
        .split('\n')
        .filter(line => !propertyKeys.some(key => line.startsWith('[' + key + ']: ')))
        .join('\n');
    equal(
      strip(command.original.stdout),
      strip(command.result.stdout),
      'Unconfigured getprop content changed'
    );
    for (const key of propertyKeys) {
      check(
        before.has(key) && after.get(key) === expected[key],
        key + ' getprop value missing/wrong'
      );
    }
  } else {
    check(command.result === 'real-process', 'Pass-through consumed/wrapped command output');
  }
  const coverage = {};
  for (const key of requiredSources) {
    const java = phase.records.filter(
      row =>
        /^SystemProperties.get\([12]\)$/.test(row.api) && row.args?.key === key && javaCaller(row)
    );
    const native = phase.records.filter(
      row =>
        row.api === 'libc.__system_property_read_callback' &&
        row.args?.key === key &&
        nativeCaller(row)
    );
    const found = phase.records.some(
      row =>
        row.api === 'libc.__system_property_find' &&
        row.args?.key === key &&
        nativeCaller(row) &&
        row.result?.found === true
    );
    check(
      java.length > 0 && native.length > 0 && found,
      key + ' actual SDK three-source coverage missing'
    );
    check(
      [...java, ...native].every(row => row.result === expected[key]),
      key + ' API delivered wrong value'
    );
    coverage[key] = { java: java.length, native: native.length, getprop: true, found };
  }
  if (phase.policy.mode === 'observe') {
    check(!phase.records.some(row => row.changed), 'Observe modified an API result');
  }
  return coverage;
}

export function evaluateRun(run) {
  const failures = [...(run.errors ?? [])];
  const rows = [];
  const snapshots = {};
  const ids = new Set();
  let profiles;
  try {
    const baseline = readBuildSnapshot(run.phases?.baseline?.response);
    profiles = profilesFromFingerprint(baseline.reportedFields.FINGERPRINT);
    equal(run.profiles, profiles, 'Recorded profiles differ from baseline-derived experiment');
    check(baseline.virtualBuild.length > 0, 'No actual baseline Build finding');
  } catch (error) {
    failures.push('baseline: ' + error.message);
  }
  for (const name of phaseNames) {
    try {
      const phase = run.phases?.[name];
      check(phase && profiles, 'Phase/profiles missing');
      const value = readBuildSnapshot(phase.response);
      check(
        value.scan.pid === phase.pid && !ids.has(value.scan.scanId),
        'Wrong PID or reused scan ID'
      );
      ids.add(value.scan.scanId);
      snapshots[name] = value;
      rows.push({
        phase: name,
        critical: value.critical,
        review: value.review,
        systemStatus: value.status.severity,
        virtualizationStatus: value.virtual.status.severity,
        buildFindings: value.virtualBuild.length,
        scanId: value.scan.scanId,
        fields: value.reportedFields,
        verdict: value.report.verdict,
      });
      if (injectedPhases.includes(name)) {
        const expectedPolicy = profiles[name] ?? observe;
        equal(phase.policy, expectedPolicy, 'Unexpected policy');
        verifyControls(phase.controls);
        const baselineControls = run.phases.observe?.controls;
        check(
          baselineControls?.fields && baselineControls.properties && baselineControls.unrelated,
          'Original field/property controls missing'
        );
        const expectedFields = { ...baselineControls.fields, ...expectedPolicy.rules?.buildFields };
        const expectedProperties = {
          ...baselineControls.properties,
          ...expectedPolicy.rules?.properties,
        };
        for (const key of propertyKeys) {
          check(
            typeof baselineControls.properties[key] === 'string' &&
              baselineControls.properties[key].length > 0 &&
              baselineControls.properties[key] !== 'AF_PROPERTY_MISSING',
            key + ' baseline property missing/unreadable'
          );
        }
        equal(phase.controls.fields, expectedFields, 'Field readback differs from policy/baseline');
        equal(
          phase.controls.properties,
          expectedProperties,
          'Property controls differ from policy/baseline'
        );
        equal(
          phase.controls.unrelated,
          baselineControls.unrelated,
          'Unrelated framework fields changed'
        );
        for (const [key, fieldValue] of Object.entries(value.reportedFields)) {
          check(fieldValue === expectedFields[key], key + ' original SDK field differs');
        }
        for (const [key, property] of Object.entries(value.reportedProperties)) {
          check(property === expectedProperties[key], key + ' original SDK property differs');
        }
        const receipts = phase.configuration?.buildFields;
        check(receipts && typeof receipts === 'object', 'Field receipts missing');
        for (const [key, receipt] of Object.entries(receipts)) {
          check(
            Object.hasOwn(expectedFields, key) &&
              receipt.original === baselineControls.fields[key] &&
              receipt.current === expectedFields[key],
            'Wrong field receipt: ' + key
          );
          if (!expectedPolicy.rules?.buildFields?.[key]) {
            check(receipt.restored === true, key + ' restoration not confirmed');
          }
        }
        for (const key of Object.keys(expectedPolicy.rules?.buildFields ?? {})) {
          check(
            Object.hasOwn(receipts, key) && receipts[key].requested === expectedFields[key],
            'Requested field receipt missing: ' + key
          );
        }
        phase.sourceCoverage = apiEvidence(phase, expectedProperties);
      }
    } catch (error) {
      failures.push(name + ': ' + error.message);
    }
  }
  const baseline = snapshots.baseline;
  if (baseline) {
    for (const [name, value] of Object.entries(snapshots)) {
      try {
        equal(value.unrelated, baseline.unrelated, 'Unrelated static report changed');
        for (const [key, count] of Object.entries(baseline.coverage)) {
          check(value.coverage[key] >= count, key + ' source coverage decreased');
        }
        if (
          ['baseline', 'observe', 'restored', 'after-unload-1', 'after-unload-2', 'cold'].includes(
            name
          )
        ) {
          equal(value.stable, baseline.stable, 'Selected report restoration failed');
          equal(value.virtualBuild, baseline.virtualBuild, 'Original Build findings not restored');
          check(
            value.critical === baseline.critical && value.review === baseline.review,
            'Original counts not restored'
          );
        }
        check(
          name === 'cold'
            ? value.scan.pid !== baseline.scan.pid
            : value.scan.pid === baseline.scan.pid,
          'Unexpected process identity'
        );
      } catch (error) {
        failures.push(name + ': ' + error.message);
      }
    }
  }
  try {
    const combined = snapshots.combined;
    const inconsistent = snapshots.inconsistent;
    check(combined && inconsistent && snapshots['properties-only'], 'Comparison results missing');
    check(
      combined.critical < snapshots['properties-only'].critical,
      'Original SDK Critical count did not decrease with Build composition'
    );
    check(combined.virtualBuild.length === 0, 'Configured Build findings remain');
    check(combined.rows.Source.size === 0, 'Combined profile has source mismatch');
    const consistency = combined.rows.Consistency;
    check(
      ![...consistency.keys()].some(key => /Build\.|fingerprint tail/.test(key)),
      'Combined profile has framework/fingerprint mismatch'
    );
    for (const key of mismatchLabels) {
      check(
        inconsistent.rows.Consistency.has(key) && !consistency.has(key),
        'Original SDK mismatch control missing: ' + key
      );
    }
    equal(
      snapshots['properties-only'].virtualBuild,
      baseline.virtualBuild,
      'Property-only phase changed original Build findings'
    );
  } catch (error) {
    failures.push('comparison: ' + error.message);
  }
  if (!run.cleanup?.complete || run.toolStatus !== 'passed') {
    failures.push('Execution/cleanup incomplete');
  }
  for (const key of Object.keys(fields)) {
    if (run.finalInstallation?.buildFields?.[key]?.restored !== true) {
      failures.push('Final field restoration not confirmed: ' + key);
    }
  }
  if (
    !['local-build', 'production-artifact'].includes(run.agentSource) ||
    !/^[a-f0-9]{64}$/.test(run.apiAgentSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(run.scriptSha256 ?? '')
  ) {
    failures.push('Agent provenance missing');
  }
  if (
    run.agentSource === 'production-artifact' &&
    (run.productionManifest?.schemaVersion !== 2 ||
      run.productionManifest.production !== true ||
      run.productionManifest.files?.['dist/android-api.js'] !== run.apiAgentSha256)
  ) {
    failures.push('Public bytes do not match production manifest');
  }
  return { passed: failures.length === 0, failures, rows };
}

export function renderReport(run) {
  return [
    '# Duck Build/property composition',
    '',
    'Result: **' + (run.evaluation.passed ? 'PASS' : 'FAIL') + '**',
    'Scope: selected main-process framework fields and property API views. Native artifacts, startup snapshots, helpers, graphics and syscalls retain their original meaning.',
    'Public bundle SHA256: `' + run.apiAgentSha256 + '`',
    '',
    '| Phase | Critical | Review | Build findings | System status | Virtualization status |',
    '| --- | --- | --- | --- | --- | --- |',
    ...run.evaluation.rows.map(
      row =>
        '| ' +
        [
          row.phase,
          row.critical,
          row.review,
          row.buildFindings,
          row.systemStatus,
          row.virtualizationStatus,
        ].join(' | ') +
        ' |'
    ),
    '',
    'Original reports retain all findings. Field receipts and supplemental controls are not SDK API-call coverage.',
    '',
    ...run.evaluation.failures.map(error => '- ' + error),
    '',
  ].join('\n');
}
