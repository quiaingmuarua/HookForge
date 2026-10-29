import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openComposition } from '../../hosts/node-cli/run.js';
import { options } from '../duck-system-properties/run.mjs';
import { sample } from '../rootbeer/catalog.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, '../..');
const args = options(process.argv.slice(2));
if (args) {
  if (createHash('sha256').update(fs.readFileSync(args.apk)).digest('hex') !== sample.sha256) {
    throw new Error('Wrong fixed RootBeer APK');
  }
  const argv = [
    'run',
    '--serial',
    args.serial,
    '--spawn',
    sample.package,
    '--replace',
    'root,system-properties',
    '--trace',
    'file-io,system-properties',
    '--script',
    path.join(directory, 'rootbeer-ui.ts'),
  ];
  if (args.agent) {
    argv.push('--agent', args.agent, '--production-manifest', args['production-manifest']);
  }
  if (args.output) {
    argv.push('--output', args.output);
  }
  const run = await openComposition(argv, workspace);
  const { session, output } = run;
  const proof = { phases: {}, errors: [] };
  const interrupt = () => session.cancel();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    run.result.environment = session.environment();
    run.result.apk = session.installApk(args.apk);
    await session.prepare();
    await session.inject();
    await session.exports.configure({ mode: 'observe', captureStack: true });
    proof.identity = await session.exports.init();
    if (proof.identity.package !== sample.package || proof.identity.version !== sample.version) {
      throw new Error('Wrong RootBeer identity');
    }
    for (const [name, policy] of [
      ['baseline', { mode: 'observe', captureStack: true }],
      ['normal', run.plan.policy],
      ['restored', { mode: 'observe', captureStack: true }],
    ]) {
      await session.exports.configure(policy);
      const tap = await session.exports.prepareui();
      await session.exports.drain();
      session.adb(['shell', 'input', 'tap', String(tap.x), String(tap.y)]);
      const ui = await session.exports.ui();
      const api = await session.exports.drain();
      if (api.dropped || api.records.some(item => item.error)) {
        throw new Error('RootBeer observation incomplete');
      }
      if (ui.text !== ui.expectedText || !ui.visible) {
        throw new Error('Original UI result inconsistent');
      }
      proof.phases[name] = { policy, tap, ui, ...api };
      run.write(name + '.json', proof.phases[name]);
      fs.writeFileSync(
        path.join(output, name + '.png'),
        session.adb(['exec-out', 'screencap', '-p'], true)
      );
      session.log('original RootBeer UI', { phase: name, rooted: ui.rooted, checks: ui.checks });
    }
    const { baseline, normal, restored } = proof.phases;
    if (
      !baseline.ui.rooted ||
      !baseline.ui.checks.some(item => item.value) ||
      normal.ui.rooted ||
      normal.ui.checks.some(item => item.value)
    ) {
      throw new Error('Original RootBeer result did not change');
    }
    if (JSON.stringify(restored.ui.checks) !== JSON.stringify(baseline.ui.checks)) {
      throw new Error('RootBeer restoration failed');
    }
    if (!normal.records.some(item => item.changed)) {
      throw new Error('No shared API effect observed');
    }
  } catch (error) {
    proof.errors.push(String(error));
    session.result.errors.push(String(error));
  } finally {
    await run.finish();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    proof.passed = proof.errors.length === 0 && run.result.status === 'passed';
    run.write('acceptance-result.json', proof);
    console.log(proof.passed ? 'PASS' : 'FAIL', proof.errors);
    process.exitCode = proof.passed ? 0 : 1;
  }
}
