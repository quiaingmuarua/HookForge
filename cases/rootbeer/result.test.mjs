import assert from 'node:assert/strict';
import test from 'node:test';
import { checks } from './catalog.mjs';
import { evaluateRun, renderReport } from './result.mjs';
import { readUiAttribute, readCompletedRootBeerUi } from './ui-xml.mjs';

test('post-unload UI waits for every original row without waiting away a wrong verdict', () => {
  const node = (id, text = '') =>
    `<node resource-id="com.scottyab.rootbeer.sample:id/${id}" text="${text}" />`;
  const rows = node('rootItemText').repeat(12);
  assert.equal(readCompletedRootBeerUi(rows + node('isRootedTextView', 'ROOTED*'), 12), null);
  assert.equal(readCompletedRootBeerUi(node('rootItemText').repeat(11) + node('fab'), 12), null);
  assert.equal(readCompletedRootBeerUi(rows + node('fab'), 12), null);
  assert.equal(
    readCompletedRootBeerUi(rows + node('fab') + node('isRootedTextView', 'ROOTED*'), 12),
    'ROOTED*'
  );
  // A completed wrong result must reach the existing comparison immediately.
  assert.equal(
    readCompletedRootBeerUi(rows + node('fab') + node('isRootedTextView', 'NOT ROOTED'), 12),
    'NOT ROOTED'
  );
});

test('post-unload UI reads XML text with either quote style and XML entities', () => {
  assert.equal(readUiAttribute('<node text="ROOTED*" />', 'text'), 'ROOTED*');
  assert.deepEqual(
    JSON.parse(readUiAttribute('<node text=\'{&#10; "files": {}&#10;}\' />', 'text')),
    { files: {} }
  );
  assert.equal(
    readUiAttribute('<node text="&quot;A&amp;B&apos;&lt;&gt;&#x21;" />', 'text'),
    '"A&B\'<>!'
  );
  assert.equal(readUiAttribute(undefined, 'text'), null);
});

function observations() {
  const phase = name => {
    const positive = name === 'positive';
    const negative = name === 'negative';
    const replace = positive || negative;
    const owner = { stack: ['at com.scottyab.rootbeer.RootBeer.checkForBinary(RootBeer.java:1)'] };
    const values = {
      testKeys: !negative,
      dangerousProps: !negative,
      suBinary: positive,
      nativeRoot: positive,
    };
    const props = debug => '[ro.build.version.sdk]: [33]\n[ro.debuggable]: [' + debug + ']\n';
    return {
      policy: replace
        ? {
            mode: 'replace',
            rules: {
              properties: { 'ro.debuggable': negative ? '0' : '1' },
              fileExists: { '/system/xbin/su': positive },
            },
          }
        : { mode: 'observe' },
      dropped: 0,
      ui: {
        pid: name === 'cold' ? 102 : 101,
        visible: true,
        tags: negative ? 'release-keys' : 'test-keys',
        rooted: !negative,
        text: negative ? 'not rooted' : 'rooted',
        expectedText: negative ? 'not rooted' : 'rooted',
        checks: checks.map(check => ({ label: check.label, value: values[check.id] ?? false })),
      },
      records: [
        {
          api: 'java.io.File.exists',
          args: { path: '/system/xbin/su' },
          original: false,
          result: positive,
          matched: replace,
          changed: positive,
          caller: owner,
        },
        {
          api: 'java.io.File.exists',
          args: { path: '/system/bin/su' },
          original: false,
          result: false,
          changed: false,
          caller: owner,
        },
        {
          api: 'libc.fopen',
          args: { path: '/system/xbin/su' },
          result: { opened: positive },
          matched: replace,
          changed: replace,
          caller: { module: 'libtool-checker.so' },
        },
        { api: 'PackageManager.getPackageInfo', args: { name: 'some.package' }, caller: owner },
        {
          api: 'Runtime.exec(java.lang.String)',
          args: { argv: ['getprop'] },
          caller: owner,
          original: { stdout: props('1'), exitCode: 0 },
          result: { stdout: props(negative ? '0' : '1'), exitCode: 0 },
          changed: negative,
        },
        {
          api: 'Runtime.exec(java.lang.String)',
          args: { argv: ['mount'] },
          caller: owner,
          original: { stdout: '/dev/test on /system type ext4 (ro)\n', exitCode: 0 },
          result: { stdout: '/dev/test on /system type ext4 (ro)\n', exitCode: 0 },
          changed: false,
        },
        {
          api: 'Runtime.exec([Ljava.lang.String;)',
          args: { argv: ['which', 'su'] },
          caller: owner,
        },
      ],
    };
  };
  return {
    phases: Object.fromEntries(
      ['observe', 'positive', 'negative', 'restored', 'cold'].map(name => [name, phase(name)])
    ),
    reuse: { requested: false },
    afterUnload: [101, 102].map(pid => ({
      package: 'com.scottyab.rootbeer.sample',
      pid,
      passed: true,
      rounds: [
        { pid, result: 'rooted' },
        { pid, result: 'rooted' },
      ],
    })),
    cleanup: { complete: true },
    errors: [],
  };
}

test('accepts APK-driven API observation and constructed positive/negative results', () => {
  const result = evaluateRun(observations());
  assert.equal(result.passed, true, result.failures.join('\n'));
  const native = result.rows.find(row => row.id === 'nativeRoot');
  assert.deepEqual(
    [native.observe, native.positive, native.negative, native.restored],
    [false, true, false, false]
  );
});

test('observation records a real Process without consuming its output stream', () => {
  const run = observations();
  for (const name of ['observe', 'restored', 'cold']) {
    for (const item of run.phases[name].records.filter(
      item => item.api === 'Runtime.exec(java.lang.String)'
    )) {
      delete item.original;
      item.result = 'real-process';
    }
  }
  const result = evaluateRun(run);
  assert.equal(result.passed, true, result.failures.join('\n'));
});

test('a hook hit or a private probe does not prove an effect in the original APK', () => {
  for (const change of [
    run => {
      run.phases.positive.ui.checks.find(item => item.label === 'SU Binary').value = false;
    },
    run => {
      run.phases.positive.records[0].caller.stack = ['at our.PrivateProbe.invoke()'];
    },
    run => {
      run.phases.positive.records[2].result.opened = false;
    },
    run => {
      run.phases.positive.records[0].matched = false;
    },
  ]) {
    const run = observations();
    change(run);
    assert.equal(evaluateRun(run).passed, false);
  }
});

test('observation mutations, failed commands, lost events and incomplete restoration fail', () => {
  for (const change of [
    run => {
      run.phases.observe.records[0].changed = true;
    },
    run => {
      run.phases.negative.records[4].result.stdout = '';
    },
    run => {
      run.phases.negative.records[4].result.stdout =
        '[ro.build.version.sdk]: [34]\n[ro.debuggable]: [0]\n';
    },
    run => {
      run.phases.negative.dropped = 1;
    },
    run => {
      run.phases.restored.ui.tags = 'release-keys';
    },
    run => {
      run.phases.cold.ui.pid = 101;
    },
    run => {
      run.cleanup.complete = false;
    },
    run => {
      run.afterUnload = [];
    },
    run => {
      run.afterUnload[0].rounds[1].pid = 999;
    },
    run => {
      run.afterUnload[0].rounds[0].result = 'not rooted';
    },
  ]) {
    const run = observations();
    change(run);
    assert.equal(evaluateRun(run).passed, false);
  }
});

test('requested reuse cannot pass with a missing or different public bundle', () => {
  const run = observations();
  run.apiAgentSha256 = 'same-bundle';
  run.environment = { target: { apiAgentSha256: 'same-bundle' } };
  run.reuse = { requested: true, target: { apiAgentSha256: 'different-bundle' }, phases: {} };
  assert.match(evaluateRun(run).failures.join('\n'), /identical public API bundle/);
});

function reusableObservations() {
  const run = observations();
  run.apiAgentSha256 = 'same-bundle';
  run.environment = { target: { apiAgentSha256: 'same-bundle' } };
  const empty = () => ({
    javaFileCheckResult: {},
    cFileCheckNDKResult: {},
    svcFileCheckNDkResult: {},
  });
  run.reuse = {
    requested: true,
    target: { apiAgentSha256: 'same-bundle' },
    phases: Object.fromEntries(
      ['observe', 'positive', 'negative', 'restored'].map(name => {
        const positive = name === 'positive';
        const result = empty();
        if (positive) {
          result.javaFileCheckResult['/system/xbin/su'] = 'found';
          result.cFileCheckNDKResult['/system/xbin/su'] = 'ndk found';
        }
        return [
          name,
          {
            policy: structuredClone(run.phases[name].policy),
            dropped: 0,
            ui: { visible: true, pid: 201, result },
            records: [
              {
                api: 'java.io.File.exists',
                args: { path: '/system/xbin/su' },
                result: positive,
                changed: positive,
                caller: { stack: ['at com.detect.app.sample.tool.FileHelper.fileExistResult()'] },
              },
              {
                api: 'libc.fopen',
                args: { path: '/system/xbin/su' },
                result: { opened: positive },
                changed: positive,
                caller: { module: 'libdetect_sample.so' },
              },
            ],
          },
        ];
      })
    ),
  };
  run.afterUnload.push({
    package: 'com.detect.app.sample',
    pid: 201,
    passed: true,
    rounds: [0, 1].map(() => ({ pid: 201, result: empty() })),
  });
  return run;
}

test('same-bundle reuse accepts complete sparse maps, including empty negative results', () => {
  const run = reusableObservations();
  run.evaluation = evaluateRun(run);
  assert.equal(run.evaluation.passed, true, run.evaluation.failures.join('\n'));
  assert.match(renderReport(run), /javaFileCheckResult.*false \| true \| false \| false/);
});

test('missing maps and malformed App findings cannot count as positive or negative evidence', () => {
  for (const [phase, key, invalid] of [
    ['negative', 'javaFileCheckResult', undefined],
    ['negative', 'cFileCheckNDKResult', null],
    ['negative', 'svcFileCheckNDkResult', []],
    ['observe', 'javaFileCheckResult', false],
    ['positive', 'javaFileCheckResult', { '/system/xbin/su': 'error' }],
    ['positive', 'cFileCheckNDKResult', { '/system/xbin/su': true }],
    ['restored', 'cFileCheckNDKResult', 'failed to read'],
  ]) {
    const run = reusableObservations();
    run.reuse.phases[phase].ui.result[key] = invalid;
    run.evaluation = evaluateRun(run);
    assert.equal(run.evaluation.passed, false);
    assert.match(run.evaluation.failures.join('\n'), /invalid or missing file result maps/);
    const row = renderReport(run)
      .split('\n')
      .find(line => line.startsWith('| ' + key));
    assert.match(row, /missing/);
  }
});

test('reuse still requires caller evidence, matching policies, valid calls and restoration', () => {
  for (const change of [
    run => {
      run.reuse.phases.positive.records[0].caller.stack = ['at PrivateProbe.invoke()'];
    },
    run => {
      run.reuse.phases.positive.records[1].caller.module = 'private-probe.so';
    },
    run => {
      run.reuse.phases.positive.policy.rules.fileExists['/system/xbin/su'] = false;
    },
    run => {
      run.reuse.phases.positive.records[0].error = 'API call failed';
    },
    run => {
      run.reuse.phases.negative.dropped = 1;
    },
    run => {
      run.reuse.phases.restored.ui.result.javaFileCheckResult['/system/xbin/su'] = 'found';
    },
    run => {
      run.reuse.phases.positive.ui.result.svcFileCheckNDkResult['/system/xbin/su'] = 'svc found';
    },
  ]) {
    const run = reusableObservations();
    change(run);
    assert.equal(evaluateRun(run).passed, false);
  }
});
