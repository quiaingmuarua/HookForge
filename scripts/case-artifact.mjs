import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Inspect the ZIP directory without extracting APKs or requiring a platform unzip tool.
export function apkNativeAbis(bytes, library) {
  if (bytes.length < 22) {
    throw new Error('Invalid APK ZIP directory');
  }
  let end = bytes.length - 22;
  const minimum = Math.max(0, end - 65535);
  while (end >= minimum && bytes.readUInt32LE(end) !== 0x06054b50) {
    end--;
  }
  if (end < minimum || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) {
    throw new Error('Invalid or unsupported APK ZIP directory');
  }
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  const limit = cursor + size;
  if (count === 0xffff || limit > end || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) {
    throw new Error('Invalid or unsupported APK ZIP directory');
  }
  const abis = new Set();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > limit || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid APK ZIP entry');
    }
    const length = bytes.readUInt16LE(cursor + 28);
    const next =
      cursor + 46 + length + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    if (next > limit) {
      throw new Error('Truncated APK ZIP entry');
    }
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + length);
    const parts = name.split('/');
    if (parts.length === 3 && parts[0] === 'lib' && parts[2] === library) {
      abis.add(parts[1]);
    }
    cursor = next;
  }
  if (cursor !== limit) {
    throw new Error('Invalid APK ZIP directory size');
  }
  return [...abis].sort();
}

export function productionAgent(agentPath, manifestPath) {
  const verified = spawnSync(
    process.execPath,
    [path.join(workspace, 'scripts/production-artifact.mjs'), 'verify', manifestPath],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 }
  );
  if (verified.error || verified.status !== 0) {
    throw new Error(
      'Production artifact verification failed: ' +
        (verified.error?.message ?? verified.stderr ?? verified.stdout)
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bytes = fs.readFileSync(agentPath);
  if (sha256(bytes) !== manifest.files['dist/android-api.js']) {
    throw new Error('Supplied API agent differs from the production manifest');
  }
  return { source: bytes.toString('utf8'), manifest };
}
