import { isDeepStrictEqual } from 'node:util';
import { attributes } from './catalog.mjs';

const sorted = values => [...values].sort();
const selected = line =>
  attributes.some(([, label]) => line.startsWith('- Detected ' + label + ': '));
export function evaluateRun(run) {
  try {
    return evaluateEvidence(run);
  } catch (error) {
    return { passed: false, failures: ['Malformed evidence: ' + error], rows: [] };
  }
}
function evaluateEvidence(run) {
  const failures = [];
  const check = (condition, reason) => {
    if (!condition) {
      failures.push(reason);
    }
  };
  const rows = [];
  const phases = run.phases ?? {};
  const baseline = phases.baseline;
  const pids = new Set();
  check(run.errors?.length === 0, 'Execution failed');
  check(run.cleanup?.complete === true, 'Cleanup incomplete');
  check(Boolean(baseline?.ui?.findings?.length), 'Original baseline missing or not detected');
  const outside = baseline?.ui?.findings?.filter(line => !selected(line)) ?? [];
  const observed = phases.observe?.records ?? [];
  const original = {};
  for (const [key] of attributes) {
    const calls = observed.filter(
      row =>
        row.api === 'libc.__system_property_get' &&
        row.args?.key === key &&
        row.caller?.module === 'libemulatordetector.so'
    );
    check(
      calls.length > 0 &&
        calls.every(
          row =>
            typeof row.original === 'string' &&
            row.original.length &&
            row.args?.found &&
            row.result === row.original
        ),
      'Missing readable original SDK property: ' + key
    );
    if (calls.length) {
      original[key] = calls[0].original;
    }
  }
  for (const name of ['baseline', 'observe', 'risk', 'normal', 'cold']) {
    const phase = phases[name];
    check(
      Boolean(
        phase &&
          Number.isInteger(phase.pid) &&
          phase.pid > 0 &&
          phase.ui?.pid === phase.pid &&
          Array.isArray(phase.ui?.findings)
      ),
      name + ': missing original UI/PID'
    );
    if (!phase?.ui?.findings) {
      continue;
    }
    check(!pids.has(phase.pid), name + ': reused process');
    pids.add(phase.pid);
    check(phase.toolPassed === true, name + ': lifecycle failed');
    check(
      isDeepStrictEqual(sorted(phase.ui.findings.filter(line => !selected(line))), sorted(outside)),
      name + ': unrelated findings changed'
    );
    check(
      phase.ui.findings.includes('- Detected x86 Architecture'),
      name + ': true x86 ABI evidence missing'
    );
    if (['baseline', 'cold'].includes(name)) {
      check(phase.instrumentation === 'none', name + ': must have no script');
    } else {
      check(phase.instrumentation === 'composition', name + ': script evidence missing');
      check(
        phase.apiAgentSha256 === run.apiAgentSha256 && Boolean(run.apiAgentSha256),
        name + ': different public script'
      );
      check(
        phase.nativeStartup?.pid === phase.pid &&
          Number.isFinite(phase.nativeStartup?.readyAt) &&
          phase.nativeStartup?.installed?.includes('libc.__system_property_get'),
        name + ': native startup evidence missing'
      );
      check(
        phase.dropped === 0 && !phase.records?.some(row => row.runtimeError),
        name + ': observations incomplete'
      );
      for (const [key, label] of attributes) {
        const expected =
          name === 'observe' ? original[key] : phase.policy?.rules?.properties?.[key];
        const calls = (phase.records ?? []).filter(
          row =>
            row.api === 'libc.__system_property_get' &&
            row.args?.key === key &&
            row.caller?.module === 'libemulatordetector.so'
        );
        check(
          calls.length > 0 &&
            calls.every(
              row =>
                row.result === expected &&
                row.resultReturn === Buffer.byteLength(expected ?? '', 'utf8') &&
                row.ts >= phase.nativeStartup?.readyAt
            ),
          name + ': SDK delivery/source/timing invalid: ' + key
        );
        check(
          phase.controls?.properties?.[key]?.found === true &&
            phase.controls.properties[key].value === expected &&
            phase.controls.properties[key].length === Buffer.byteLength(expected ?? '', 'utf8'),
          name + ': configured control incomplete: ' + key
        );
        if (name === 'risk') {
          check(
            phase.ui.findings.filter(line => line === '- Detected ' + label + ': ' + expected)
              .length === 1,
            name + ': original finding did not appear: ' + key
          );
        }
        if (name === 'normal') {
          check(
            !phase.ui.findings.some(line => line.startsWith('- Detected ' + label + ': ')),
            name + ': original property finding remained: ' + key
          );
        }
        for (const point of ['restoredControls', 'disposedControls']) {
          const control = phase[point];
          check(
            control?.pid === phase.pid &&
              control.arch === 'x64' &&
              control.properties?.[key]?.found === true &&
              control.properties[key].value === original[key] &&
              control.properties[key].length === Buffer.byteLength(original[key] ?? '', 'utf8'),
            name + ': property restoration failed at ' + point + ': ' + key
          );
        }
      }
      check(
        phase.controls?.pid === phase.pid && phase.controls?.arch === 'x64',
        name + ': controls outside original process'
      );
      for (const key of [
        'ro.product.cpu.abilist',
        'ro.build.version.sdk',
        'ro.build.version.release',
      ]) {
        const value = phase.controls?.unrelated?.[key];
        check(
          value?.found === true &&
            typeof value.value === 'string' &&
            value.value.length > 0 &&
            value.length === Buffer.byteLength(value.value, 'utf8'),
          name + ': missing unrelated control: ' + key
        );
      }
      check(
        phase.controls?.unrelated?.['ro.product.cpu.abilist']?.value?.includes('x86_64'),
        name + ': actual ABI control missing'
      );
      check(
        isDeepStrictEqual(phase.controls?.unrelated, phases.observe?.controls?.unrelated) &&
          Boolean(phase.controls?.unrelated),
        name + ': unrelated control values changed'
      );
      check(
        isDeepStrictEqual(phase.restoredControls?.unrelated, phase.controls?.unrelated) &&
          isDeepStrictEqual(phase.disposedControls?.unrelated, phase.controls?.unrelated),
        name + ': unrelated controls failed restoration'
      );
      check(
        phase.dispose?.restored === true &&
          phase.afterUnload?.pid === phase.pid &&
          isDeepStrictEqual(phase.afterUnload?.findings, phase.ui.findings),
        name + ': unload changed cached UI or process'
      );
    }
    if (name === 'observe' || name === 'cold') {
      check(
        isDeepStrictEqual(sorted(phase.ui.findings), sorted(baseline?.ui?.findings ?? [])),
        name + ': original result differs from baseline'
      );
    }
    rows.push({
      phase: name,
      pid: phase.pid,
      propertyFindings: phase.ui.findings.filter(selected).length,
      otherFindings: phase.ui.findings.filter(line => !selected(line)).length,
    });
  }
  return { passed: failures.length === 0, failures, rows };
}

export function renderReport(run) {
  return (
    '# Reveny native property migration\n\nResult: **' +
    (run.evaluation.passed ? 'PASS' : 'FAIL') +
    '**\n\n' +
    'Scope: five property inputs, original first-scan findings and API/cold-process restoration. CPU/ABI and other detections retain their meaning. Cached findings need not change after API restoration.\n\n' +
    'Public SHA256: `' +
    (run.apiAgentSha256 ?? 'missing') +
    '`\n\n' +
    '| Phase | PID | Property findings | Other findings |\n| --- | --- | --- | --- |\n' +
    run.evaluation.rows
      .map(row => `| ${row.phase} | ${row.pid} | ${row.propertyFindings} | ${row.otherFindings} |`)
      .join('\n') +
    '\n\n' +
    run.evaluation.failures.map(reason => '- ' + reason).join('\n') +
    '\n'
  );
}
