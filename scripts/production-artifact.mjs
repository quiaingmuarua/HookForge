import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { applyBridgePatch } from './patch-java-bridge.mjs';

const fridaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = fridaRoot;
const manifestPath =
  process.argv[3] || path.join(repoRoot, '.runtime/frida-api33/production-manifest.json');
const files = [
  'dist/bundle.js',
  'dist/android-api.js',
  ...['run', 'run-recipe', 'recipe-runner', 'parse-log'].map(name => `dist/node-cli/${name}.js`),
];
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const packageLockSha256 = sha256(path.join(fridaRoot, 'package-lock.json'));
const javaBridgePatch = applyBridgePatch(fridaRoot, { check: true });

if (process.argv[2] === 'write') {
  if (process.env.NODE_ENV !== 'production') {
    throw new Error('Write the manifest immediately after build:prod with NODE_ENV=production');
  }
  const manifest = {
    schemaVersion: 2,
    production: true,
    commit,
    nodeVersion: process.version,
    packageLockSha256,
    javaBridgePatch,
    files: Object.fromEntries(files.map(file => [file, sha256(path.join(fridaRoot, file))])),
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} else if (process.argv[2] === 'verify') {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    manifest.schemaVersion !== 2 ||
    manifest.production !== true ||
    manifest.commit !== commit ||
    manifest.packageLockSha256 !== packageLockSha256 ||
    manifest.nodeVersion !== process.version ||
    !isDeepStrictEqual(manifest.javaBridgePatch, javaBridgePatch)
  ) {
    throw new Error('Production artifact metadata differs from this checkout/toolchain');
  }
  if (Object.keys(manifest.files).sort().join('\n') !== [...files].sort().join('\n')) {
    throw new Error('Production artifact file list differs from the expected entrypoints');
  }
  for (const file of files) {
    if (sha256(path.join(fridaRoot, file)) !== manifest.files[file]) {
      throw new Error(`Production artifact checksum mismatch: ${file}`);
    }
  }
} else {
  throw new Error('Usage: node scripts/production-artifact.mjs write|verify [manifest.json]');
}
console.log(`Production artifact ${process.argv[2]}: ${manifestPath}`);
