import { isDeepStrictEqual } from 'node:util';
import { sdk, keys, packageName, eventCode, phaseNames, risk, normal, observe } from './spec.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireThat = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};
const equal = (a, b, label) => requireThat(isDeepStrictEqual(a, b), label);

function indexed(items, label) {
  requireThat(Array.isArray(items), label + ' missing');
  const map = new Map();
  for (const item of items) {
    requireThat(
      object(item) &&
        typeof item.label === 'string' &&
        typeof item.value === 'string' &&
        !map.has(item.label),
      label + ' contains invalid/duplicate values'
    );
    map.set(item.label, item);
  }
  return map;
}

export function readSnapshot(
  response,
  detectorIds = ['system_properties'],
  allowSourceMismatch = false
) {
  requireThat(
    object(response) && response.status === 'succeeded' && response.eventCode === eventCode,
    'Scan HTTP event failed'
  );
  const scan = response.result;
  requireThat(
    object(scan) &&
      typeof scan.scanId === 'string' &&
      scan.scanId.length > 0 &&
      Number.isInteger(scan.pid) &&
      scan.pid > 0 &&
      scan.apiLevel === 33 &&
      Array.isArray(scan.abis) &&
      scan.abis.includes('x86_64') &&
      Number.isFinite(scan.startedAtMillis) &&
      Number.isFinite(scan.finishedAtMillis) &&
      scan.finishedAtMillis >= scan.startedAtMillis,
    'Scan identity/timing missing or invalid'
  );
  equal(
    scan.sdk,
    { tag: sdk.tag, commit: sdk.commit, aarSha256: sdk.sha256 },
    'Wrong SDK identity'
  );
  requireThat(
    scan.host?.app?.packageName === packageName && scan.host.app.targetSdk === 33,
    'Wrong host identity'
  );
  requireThat(
    scan.host.launchCapture?.intentExtraKeys?.includes('early_detection_has_run') &&
      scan.host.mountSampler?.attached === true,
    'SDK launch/sampler conditions missing'
  );
  equal(scan.requestedDetectorIds, detectorIds, 'Wrong requested scope');
  equal(scan.executedDetectorIds, detectorIds, 'Wrong executed scope');
  requireThat(
    Array.isArray(scan.results) &&
      scan.results.length === detectorIds.length &&
      new Set(scan.results.map(item => item?.id)).size === detectorIds.length &&
      detectorIds.every(id => scan.results.some(item => item?.id === id)),
    'Incomplete detector results'
  );
  const { status, report } = scan.results.find(item => item.id === 'system_properties');
  requireThat(
    object(status) &&
      ['DANGER', 'WARNING', 'ALL_CLEAR', 'INFO'].includes(status.severity) &&
      (status.severity !== 'INFO' || status.infoKind === 'SUPPORT'),
    'Detector error/invalid status'
  );
  requireThat(
    object(report) &&
      report.severity === status.severity &&
      typeof report.verdict === 'string' &&
      report.verdict.length > 0 &&
      typeof scan.reportText === 'string' &&
      scan.reportText.trim().length > 0,
    'Missing report'
  );
  const facts = indexed(report.quickFacts, 'quickFacts');
  const count = label => {
    const value = facts.get(label)?.value;
    requireThat(
      value === 'None' || /^(0|[1-9][0-9]*)$/.test(value ?? ''),
      label + ' count invalid'
    );
    return value === 'None' ? 0 : Number(value);
  };
  requireThat(Array.isArray(report.blocks), 'Report blocks missing');
  const blocks = new Map();
  for (const block of report.blocks) {
    requireThat(
      object(block) && typeof block.title === 'string' && !blocks.has(block.title),
      'Invalid/duplicate report block'
    );
    if (block.type === 'rows') {
      indexed(block.rows, block.title);
      requireThat(
        block.rows.every(row => row.detail === null || typeof row.detail === 'string'),
        'Invalid row detail'
      );
    } else if (block.type === 'bullets') {
      requireThat(
        Array.isArray(block.items) && block.items.every(item => typeof item === 'string'),
        'Invalid bullets'
      );
    } else if (block.type === 'verbatim') {
      requireThat(
        Array.isArray(block.lines) && block.lines.every(line => typeof line === 'string'),
        'Invalid verbatim'
      );
    } else {
      throw new Error('Unknown report block type');
    }
    blocks.set(block.title, block);
  }
  const rows = {};
  for (const name of [
    'Core',
    'Boot',
    'Build',
    'Source',
    'Consistency',
    'Info',
    'Methods',
    'Scan',
  ]) {
    requireThat(blocks.get(name)?.type === 'rows', name + ' block missing');
    rows[name] = indexed(blocks.get(name).rows, name);
  }
  const properties = {};
  for (const key of keys) {
    const row = rows.Core.get(key);
    requireThat(row && ['0', '1'].includes(row.value), key + ' absent/unreadable');
    properties[key] = row.value;
  }
  const coverage = {};
  for (const label of ['Reflection hits', 'getprop hits', 'Native hits']) {
    const value = rows.Scan.get(label)?.value;
    requireThat(
      /^[0-9]+$/.test(value ?? '') && Number(value) >= keys.length,
      label + ' coverage unavailable'
    );
    coverage[label] = Number(value);
  }
  for (const label of ['Source mismatches', 'Cross-checks']) {
    requireThat(/^[0-9]+$/.test(rows.Scan.get(label)?.value ?? ''), label + ' missing');
  }
  requireThat(allowSourceMismatch || !rows.Source.size, 'Source mismatch reported');
  const stableRows = names =>
    Object.fromEntries(names.map(name => [name, [...rows[name].values()]]));
  return {
    scan,
    report,
    status,
    facts,
    rows,
    properties,
    coverage,
    critical: count('Critical'),
    review: count('Review'),
    stable: {
      status,
      verdict: report.verdict,
      facts: [...facts.values()],
      rows: stableRows(['Core', 'Boot', 'Build', 'Source', 'Consistency', 'Info', 'Scan']),
    },
    unrelated: {
      ...stableRows(['Boot', 'Build', 'Source', 'Consistency', 'Info']),
      Core: [...rows.Core.values()].filter(row => !keys.includes(row.label)),
    },
  };
}

export function parseGetprop(text) {
  requireThat(typeof text === 'string' && text.trim().length > 0, 'getprop output empty');
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
    if (!match) {
      continue;
    }
    requireThat(!values.has(match[1]), 'Duplicate getprop key');
    values.set(match[1], match[2]);
  }
  requireThat(values.size > 0, 'getprop output malformed');
  return values;
}

export function verifyControls(controls) {
  requireThat(
    object(controls) &&
      controls.sdk === '33' &&
      controls.sdkDefault === '33' &&
      controls.missingDefault === 'control-default' &&
      controls.ownPackage === packageName &&
      controls.fileExists === true &&
      controls.missingRuntime === true &&
      controls.missingBuilder === true,
    'Unrelated API controls failed'
  );
  for (const source of ['runtime', 'builder']) {
    equal(
      controls[source],
      { stdout: 'control-out', stderr: 'control-error', exitCode: 7 },
      source + ' ordinary process changed'
    );
  }
}

export const javaCaller = item =>
  item.caller?.stack?.some(line =>
    line.includes(
      'com.eltavine.duckdetector.capability.systemproperties.data.SystemPropertyReadUtils.'
    )
  );
export const nativeCaller = item => item.caller?.module === 'libduckdetector.so';

export function evaluateRun(run) {
  const failures = [...(run.errors ?? [])];
  const rows = [];
  const snapshots = {};
  const scanIds = new Set();
  for (const name of phaseNames) {
    try {
      const phase = run.phases?.[name];
      requireThat(object(phase), 'Phase missing');
      const value = readSnapshot(phase.response);
      requireThat(!scanIds.has(value.scan.scanId), 'Reused scan ID');
      scanIds.add(value.scan.scanId);
      requireThat(value.scan.pid === phase.pid, 'Scan did not run in verified main PID');
      snapshots[name] = value;
      rows.push({
        phase: name,
        ...value.properties,
        critical: value.critical,
        review: value.review,
        severity: value.status.severity,
        verdict: value.report.verdict,
        scanId: value.scan.scanId,
      });
      if (['observe', 'risk', 'normal', 'restored'].includes(name)) {
        equal(
          phase.policy,
          name === 'risk' ? risk : name === 'normal' ? normal : observe,
          'Wrong policy'
        );
        verifyControls(phase.controls);
        requireThat(
          Array.isArray(phase.records) &&
            phase.dropped === 0 &&
            !phase.records.some(item => item.error),
          'API observations missing/truncated/failed'
        );
        if (['observe', 'restored'].includes(name)) {
          requireThat(!phase.records.some(item => item.changed), 'Observe changed behavior');
        }
        {
          const replacing = ['risk', 'normal'].includes(name);
          const expected = replacing ? phase.policy.rules.properties : value.properties;
          equal(value.properties, expected, 'Original SDK values did not match policy');
          const commands = phase.records.filter(
            item =>
              item.api === 'ProcessBuilder.start' &&
              ['getprop', '/system/bin/getprop'].includes(item.args?.argv?.[0]) &&
              item.args.argv.length === 1 &&
              javaCaller(item)
          );
          requireThat(
            commands.length === 1,
            'Duck ProcessBuilder getprop coverage missing/duplicated'
          );
          const command = commands[0];
          if (replacing) {
            requireThat(
              command.original?.exitCode === 0 && command.result?.exitCode === 0,
              'getprop command failed'
            );
            const before = parseGetprop(command.original.stdout);
            const after = parseGetprop(command.result.stdout);
            const strip = text =>
              text
                .split('\n')
                .filter(line => !keys.some(key => line.startsWith('[' + key + ']: ')))
                .join('\n');
            equal(
              strip(command.original.stdout),
              strip(command.result.stdout),
              'Unrelated getprop content changed'
            );
            for (const key of keys) {
              requireThat(
                before.has(key) && after.get(key) === expected[key],
                key + ' getprop value missing/wrong'
              );
            }
          } else {
            requireThat(
              command.result === 'real-process',
              'Observe consumed or wrapped the process'
            );
          }
          for (const key of keys) {
            const java = phase.records.filter(
              item =>
                /^SystemProperties.get\([12]\)$/.test(item.api) &&
                item.args?.key === key &&
                javaCaller(item)
            );
            const native = phase.records.filter(
              item =>
                item.api === 'libc.__system_property_read_callback' &&
                item.args?.key === key &&
                nativeCaller(item)
            );
            const find = phase.records.some(
              item =>
                item.api === 'libc.__system_property_find' &&
                item.args?.key === key &&
                nativeCaller(item) &&
                item.result?.found === true
            );
            requireThat(
              java.length > 0 && native.length > 0 && find,
              key + ' actual SDK API caller coverage missing'
            );
            requireThat(
              [...java, ...native].every(item => item.result === expected[key]),
              key + ' API values disagree'
            );
          }
        }
      }
    } catch (error) {
      failures.push(name + ': ' + error.message);
    }
  }
  const baseline = snapshots.baseline;
  if (baseline) {
    for (const name of phaseNames.filter(name => name !== 'baseline')) {
      const value = snapshots[name];
      if (!value) {
        continue;
      }
      if (!isDeepStrictEqual(value.unrelated, baseline.unrelated)) {
        failures.push(name + ': unrelated static report content changed');
      }
      for (const key of Object.keys(baseline.coverage)) {
        if (value.coverage[key] < baseline.coverage[key]) {
          failures.push(name + ': source coverage decreased');
        }
      }
      if (!['risk', 'normal'].includes(name) && !isDeepStrictEqual(value.stable, baseline.stable)) {
        failures.push(name + ': baseline restoration failed');
      }
      if (name !== 'cold' && value.scan.pid !== baseline.scan.pid) {
        failures.push(name + ': main process changed during experiment');
      }
    }
    if (snapshots.cold?.scan.pid === baseline.scan.pid) {
      failures.push('cold: expected a fresh main process');
    }
  }
  if (!(snapshots.normal?.critical < snapshots.risk?.critical)) {
    failures.push('Original SDK Critical count did not decrease from risk to normal');
  }
  if (!run.cleanup?.complete) {
    failures.push('Cleanup incomplete');
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
    (run.productionManifest?.production !== true ||
      run.productionManifest.schemaVersion !== 2 ||
      run.productionManifest.files?.['dist/android-api.js'] !== run.apiAgentSha256)
  ) {
    failures.push('Public API bytes differ from the verified production manifest');
  }
  return { passed: failures.length === 0, failures, rows };
}

export function renderReport(run) {
  return [
    '# Duck system-properties shared API experiment',
    '',
    'Result: **' + (run.evaluation.passed ? 'PASS' : 'FAIL') + '**',
    'Scope: API33 x86_64; four property inputs via Java, getprop and native callback. Other findings retain their original meaning.',
    'Agent: ' + run.agentSource + '; public SHA256: `' + run.apiAgentSha256 + '`',
    '',
    '| Phase | ro.debuggable | ro.secure | ro.adb.secure | service.adb.root | Critical | Review | SDK status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.evaluation.rows.map(
      row =>
        '| ' +
        [row.phase, ...keys.map(key => row[key]), row.critical, row.review, row.severity].join(
          ' | '
        ) +
        ' |'
    ),
    '',
    'Each phase retains its full original HTTP response, JSON, text and separate API/control evidence.',
    '',
    ...run.evaluation.failures.map(failure => '- ' + failure),
    '',
  ].join('\n');
}
