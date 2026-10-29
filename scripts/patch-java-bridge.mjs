import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadataFile = 'patches/frida-java-bridge-7.0.13.patch.json';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify or apply the one reviewed patch to the exact official npm package bytes. */
export function applyBridgePatch(fridaRoot = workspace, { check = false } = {}) {
  const metadataBytes = fs.readFileSync(path.join(fridaRoot, metadataFile));
  const patch = JSON.parse(metadataBytes.toString('utf8'));
  if (
    patch.schemaVersion !== 1 ||
    patch.id !== 'frida-java-bridge-7.0.13-art-initial-sync' ||
    patch.packageName !== 'frida-java-bridge' ||
    patch.packageVersion !== '7.0.13' ||
    patch.targetFile !== 'lib/android.js' ||
    !['originalSha256', 'patchedSha256'].every(field => /^[a-f0-9]{64}$/.test(patch[field])) ||
    !['before', 'after'].every(
      field =>
        Array.isArray(patch.replacement?.[field]) &&
        patch.replacement[field].length > 0 &&
        patch.replacement[field].every(line => typeof line === 'string')
    )
  ) {
    throw new Error('Invalid reviewed Frida Java bridge patch metadata');
  }
  const locked = JSON.parse(fs.readFileSync(path.join(fridaRoot, 'package-lock.json'), 'utf8'))
    .packages?.['node_modules/frida-java-bridge'];
  const packageRoot = path.join(fridaRoot, 'node_modules/frida-java-bridge');
  const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (
    installed.name !== patch.packageName ||
    installed.version !== patch.packageVersion ||
    locked?.version !== patch.packageVersion ||
    locked?.resolved !== patch.sourceTarball ||
    locked?.integrity !== patch.sourceIntegrity
  ) {
    throw new Error(
      'Frida Java bridge package version or npm lock differs from the reviewed patch'
    );
  }
  const target = path.join(packageRoot, patch.targetFile);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Frida Java bridge patch target must be a regular installed file');
  }
  const original = fs.readFileSync(target);
  const actualSha256 = sha256(original);
  const evidence = {
    id: patch.id,
    packageName: patch.packageName,
    packageVersion: patch.packageVersion,
    metadataSha256: sha256(metadataBytes),
    originalSha256: patch.originalSha256,
    patchedSha256: patch.patchedSha256,
  };
  if (actualSha256 === patch.patchedSha256) {
    return evidence;
  }
  if (actualSha256 !== patch.originalSha256) {
    throw new Error('Unknown Frida Java bridge bytes; refusing to patch SHA256 ' + actualSha256);
  }
  if (check) {
    throw new Error(
      'Frida Java bridge patch is not applied; run npm ci with lifecycle scripts enabled'
    );
  }
  const before = patch.replacement.before.join('\n');
  const after = patch.replacement.after.join('\n');
  const source = original.toString('utf8');
  if (source.split(before).length !== 2) {
    throw new Error('Reviewed Frida Java bridge patch must match exactly one location');
  }
  const patched = Buffer.from(source.replace(before, after));
  if (sha256(patched) !== patch.patchedSha256) {
    throw new Error('Frida Java bridge patched SHA256 differs from the reviewed metadata');
  }
  const temporary = fs.mkdtempSync(path.join(path.dirname(target), '.agentforge-bridge-patch-'));
  try {
    const output = path.join(temporary, 'android.js');
    fs.writeFileSync(output, patched, { mode: stat.mode });
    fs.renameSync(output, target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
      throw new Error('Usage: node scripts/patch-java-bridge.mjs [--check]');
    }
    const evidence = applyBridgePatch(workspace, { check: args[0] === '--check' });
    console.log('Frida Java bridge patch verified: ' + JSON.stringify(evidence));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
