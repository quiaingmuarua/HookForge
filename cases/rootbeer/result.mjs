import { checks } from './catalog.mjs';
const names = ['observe', 'positive', 'negative', 'restored', 'cold'];
const path = '/system/xbin/su';
const javaCaller = item =>
  item.caller?.stack?.some(line => line.includes('com.scottyab.rootbeer.RootBeer.'));
const nativeCaller = item => item.caller?.module === 'libtool-checker.so';
const resultOf = (phase, id) =>
  phase?.ui?.checks?.find(item => item.label === checks.find(check => check.id === id)?.label)
    ?.value;
const property = (stdout, key) =>
  stdout?.split('\n').find(line => line.startsWith('[' + key + ']: '));
const fileResultMarkers = {
  javaFileCheckResult: 'found',
  cFileCheckNDKResult: 'ndk found',
  svcFileCheckNDkResult: 'svc found',
};

// The App reports found paths only. An empty map is negative; a missing or
// malformed map is unavailable evidence, never a negative detection result.
function fileFinding(result, key) {
  const map = result?.[key];
  if (
    !map ||
    typeof map !== 'object' ||
    Array.isArray(map) ||
    Object.values(map).some(marker => marker !== fileResultMarkers[key])
  ) {
    return null;
  }
  return Object.prototype.hasOwnProperty.call(map, path);
}

export function evaluateRun(run) {
  const failures = [...(run.errors ?? [])];
  const phases = run.phases ?? {};
  const fail = message => failures.push(message);
  const rows = checks.map(check => ({
    ...check,
    ...Object.fromEntries(names.map(name => [name, resultOf(phases[name], check.id) ?? null])),
  }));
  const coverage = [];
  for (const name of names) {
    const phase = phases[name];
    if (!phase) {
      fail('Missing phase: ' + name);
      continue;
    }
    const ui = phase.ui;
    if (
      !ui?.visible ||
      !ui.text ||
      ui.text !== ui.expectedText ||
      ui.checks?.length !== checks.length ||
      checks.some(check => typeof resultOf(phase, check.id) !== 'boolean') ||
      ui.rooted !== ui.checks.some(item => item.value === true)
    ) {
      fail(name + ': original UI observations missing/inconsistent');
    }
    if (!Array.isArray(phase.records) || phase.dropped !== 0) {
      fail(name + ': API observations missing or truncated');
      continue;
    }
    const records = phase.records;
    if (records.some(item => item.error)) {
      fail(name + ': API hook/command error observed');
    }
    if (['observe', 'restored', 'cold'].includes(name) && records.some(item => item.changed)) {
      fail(name + ': observe mode changed API behavior');
    }
    const policy = phase.policy;
    const file = records.find(
      item => item.api === 'java.io.File.exists' && item.args.path === path && javaCaller(item)
    );
    const native = records.find(
      item => item.api === 'libc.fopen' && item.args.path === path && nativeCaller(item)
    );
    const props = records.find(
      item =>
        item.api === 'Runtime.exec(java.lang.String)' &&
        item.args.argv?.[0] === 'getprop' &&
        javaCaller(item)
    );
    const mount = records.find(
      item =>
        item.api === 'Runtime.exec(java.lang.String)' &&
        item.args.argv?.[0] === 'mount' &&
        javaCaller(item)
    );
    const packages = records.some(
      item => item.api === 'PackageManager.getPackageInfo' && javaCaller(item)
    );
    const which = records.some(
      item =>
        item.api === 'Runtime.exec([Ljava.lang.String;)' &&
        JSON.stringify(item.args.argv) === JSON.stringify(['which', 'su']) &&
        javaCaller(item)
    );
    if (!file || !native || !props || !mount || !packages || !which) {
      fail(name + ': actual APK API coverage/caller evidence incomplete');
    }
    for (const item of [props, mount]) {
      if (
        item?.original &&
        (item.original?.exitCode !== 0 ||
          item.result?.exitCode !== 0 ||
          !item.original.stdout?.trim() ||
          !item.result.stdout?.trim())
      ) {
        fail(name + ': failed/empty command output cannot count as a bypass');
      }
    }
    if (
      props?.original &&
      property(props.original?.stdout, 'ro.build.version.sdk') !==
        property(props.result?.stdout, 'ro.build.version.sdk')
    ) {
      fail(name + ': unrelated SDK property changed');
    }
    const modifiedKeys = Object.keys(
      policy?.mode === 'replace' ? (policy.rules?.properties ?? {}) : {}
    );
    const stripProperties = text =>
      (text ?? '')
        .split('\n')
        .filter(line => !modifiedKeys.some(key => line.startsWith('[' + key + ']: ')))
        .join('\n');
    if (
      props?.original &&
      stripProperties(props.original?.stdout) !== stripProperties(props.result?.stdout)
    ) {
      fail(name + ': unrelated getprop output changed');
    }
    if (file && native && props) {
      coverage.push({
        phase: name,
        javaFile: file.result,
        nativeOpened: native.result?.opened,
        debuggable:
          property(props.result?.stdout, 'ro.debuggable') ?? 'not consumed (observe/no rewrite)',
      });
    }
    if (['positive', 'negative'].includes(name)) {
      const positive = name === 'positive';
      if (
        resultOf(phase, 'suBinary') !== positive ||
        resultOf(phase, 'nativeRoot') !== positive ||
        resultOf(phase, 'dangerousProps') !== positive ||
        file?.result !== positive ||
        native?.result?.opened !== positive ||
        !file?.matched ||
        !native?.matched ||
        !props?.original?.stdout ||
        property(props?.result?.stdout, 'ro.debuggable') !==
          '[ro.debuggable]: [' + (positive ? '1' : '0') + ']'
      ) {
        fail(
          name + ': configured Java/native/property values did not reach the original APK checks'
        );
      }
      if (!positive && (ui?.rooted !== false || ui.checks.some(item => item.value !== false))) {
        fail('Negative profile must clear the original APK detection results');
      }
    }
    const untouchedFiles = records.filter(
      item =>
        item.api === 'java.io.File.exists' &&
        !Object.prototype.hasOwnProperty.call(
          policy?.mode === 'replace' ? (policy.rules?.fileExists ?? {}) : {},
          item.args.path
        )
    );
    if (untouchedFiles.length === 0 || untouchedFiles.some(item => item.original !== item.result)) {
      fail(name + ': unrelated file control missing/changed');
    }
  }
  for (const name of ['restored', 'cold']) {
    if (
      rows.some(row => row[name] !== row.observe) ||
      phases[name]?.ui?.tags !== phases.observe?.ui?.tags
    ) {
      fail(name + ': original APK results/Build.TAGS did not return to baseline');
    }
  }
  if (!phases.cold?.ui?.pid || phases.cold.ui.pid === phases.observe?.ui?.pid) {
    fail('Cold observation must use a new process');
  }
  const expectedUnload = [
    { package: 'com.scottyab.rootbeer.sample', ui: phases.observe?.ui },
    { package: 'com.scottyab.rootbeer.sample', ui: phases.cold?.ui },
    ...(run.reuse?.requested
      ? [{ package: 'com.detect.app.sample', ui: run.reuse.phases?.observe?.ui }]
      : []),
  ];
  for (const expected of expectedUnload) {
    const actual = run.afterUnload?.find(
      item => item.package === expected.package && item.pid === expected.ui?.pid
    );
    if (
      !actual?.passed ||
      actual.rounds?.length !== 2 ||
      actual.rounds.some(
        round =>
          round.pid !== expected.ui?.pid ||
          JSON.stringify(round.result) !== JSON.stringify(expected.ui?.result ?? expected.ui?.text)
      )
    ) {
      fail(expected.package + ': original UI/process did not recover after script unload');
    }
  }
  if (run.reuse?.requested) {
    const reuse = run.reuse;
    if (
      !run.apiAgentSha256 ||
      reuse.target?.apiAgentSha256 !== run.apiAgentSha256 ||
      run.environment?.target?.apiAgentSha256 !== run.apiAgentSha256
    ) {
      fail('Reuse must inject the identical public API bundle into both APKs');
    }
    for (const name of names.filter(name => name !== 'cold')) {
      const phase = reuse.phases?.[name];
      if (
        !phase?.ui?.visible ||
        !phase.ui.result ||
        !Array.isArray(phase.records) ||
        phase.dropped !== 0 ||
        phase.records.some(item => item.error)
      ) {
        fail('reuse/' + name + ': original UI/API observations incomplete');
        continue;
      }
      if (Object.keys(fileResultMarkers).some(key => fileFinding(phase.ui.result, key) === null)) {
        fail('reuse/' + name + ': invalid or missing file result maps');
      }
      if (JSON.stringify(phase.policy) !== JSON.stringify(phases[name]?.policy)) {
        fail('reuse/' + name + ': policy changed across APKs');
      }
      const java = phase.records.find(
        item =>
          item.api === 'java.io.File.exists' &&
          item.args.path === path &&
          item.caller?.stack?.some(line => line.includes('com.detect.app.sample.tool.FileHelper.'))
      );
      const native = phase.records.find(
        item =>
          item.api === 'libc.fopen' &&
          item.args.path === path &&
          item.caller?.module === 'libdetect_sample.so'
      );
      if (!java || !native) {
        fail('reuse/' + name + ': second APK did not naturally call shared file APIs');
      }
      if (['positive', 'negative'].includes(name)) {
        const positive = name === 'positive';
        if (
          fileFinding(phase.ui.result, 'javaFileCheckResult') !== positive ||
          fileFinding(phase.ui.result, 'cFileCheckNDKResult') !== positive ||
          java?.result !== positive ||
          native?.result?.opened !== positive
        ) {
          fail('reuse/' + name + ': shared Java/libc rules did not affect the original second APK');
        }
      } else if (phase.records.some(item => item.changed)) {
        fail('reuse/' + name + ': observation changed API results');
      }
      if (
        JSON.stringify(phase.ui.result.svcFileCheckNDkResult) !==
        JSON.stringify(reuse.phases.observe?.ui?.result?.svcFileCheckNDkResult)
      ) {
        fail('reuse/' + name + ': direct syscall behavior unexpectedly changed');
      }
    }
    if (
      JSON.stringify(reuse.phases.restored?.ui?.result) !==
      JSON.stringify(reuse.phases.observe?.ui?.result)
    ) {
      fail('Reuse APK did not return to its original result after restoring API policy');
    }
  }
  if (!run.cleanup?.complete) {
    fail('Cleanup incomplete');
  }
  return { passed: failures.length === 0, failures, rows, coverage };
}

export function renderReport(run) {
  const evaluation = run.evaluation;
  const value = item => (item === null ? 'missing' : String(item));
  const reuse = run.reuse;
  return [
    '# Shared API behavior / RootBeer',
    '',
    'Result: **' + (evaluation.passed ? 'PASS' : 'FAIL') + '**',
    'Public API bundle SHA256: ' + (run.apiAgentSha256 ?? 'not built'),
    'APK SHA256: ' + (run.environment?.installedSha256 ?? 'not verified'),
    '',
    'Only original App UI actions drive these checks. Positive/negative values come from JSON API rules.',
    'Each target appends its read-only UI adapter to the identical public bundle and shares one Java bridge.',
    'Restored/cold use observe mode; no detector return values or JNI results are patched.',
    '',
    '| Original check | Observe | Construct positive | Construct negative | Restored | Cold |',
    '| --- | --- | --- | --- | --- | --- |',
    ...evaluation.rows.map(
      row => '| ' + row.label + ' | ' + names.map(name => value(row[name])).join(' | ') + ' |'
    ),
    '',
    '| API evidence from APK callers | File.exists | libc fopen opened | getprop value |',
    '| --- | --- | --- | --- |',
    ...evaluation.coverage.map(
      row =>
        '| ' +
        row.phase +
        ' | ' +
        row.javaFile +
        ' | ' +
        row.nativeOpened +
        ' | ' +
        row.debuggable +
        ' |'
    ),
    '',
    'Java observations include caller stacks; native observations include caller module/address.',
    'Unchanged values and matched rules are distinct. A hook hit alone does not establish an APK effect.',
    '',
    'After unloading the shared bridge, two additional original UI checks must restore baseline in each same process.',
    '',
    ...(run.afterUnload ?? []).map(
      item =>
        '- ' +
        item.package +
        ' PID ' +
        item.pid +
        ': ' +
        (item.passed ? 'restored twice' : 'FAILED')
    ),
    '',
    ...(reuse?.requested
      ? [
          '## Same-bundle reuse: detect-env',
          '',
          'APK SHA256: ' + (reuse.apkSha256 ?? 'missing'),
          'Injected API bundle SHA256: ' + (reuse.target?.apiAgentSha256 ?? 'missing'),
          'The same positive/negative policies are applied without changing the API agent.',
          '',
          '| Original sensitive-files UI | Observe | Positive | Negative | Restored |',
          '| --- | --- | --- | --- | --- |',
          ...['javaFileCheckResult', 'cFileCheckNDKResult', 'svcFileCheckNDkResult'].map(
            key =>
              '| ' +
              key +
              ' (/system/xbin/su) | ' +
              names
                .filter(name => name !== 'cold')
                .map(name => value(fileFinding(reuse.phases?.[name]?.ui?.result, key)))
                .join(' | ') +
              ' |'
          ),
          '',
          'Direct syscall checks are observed but are outside these libc hooks. No claim of bypassing them.',
          '',
        ]
      : ['Second APK reuse was not requested in this run.', '']),
    ...evaluation.failures.map(failure => '- ' + failure),
    '',
  ].join('\n');
}
