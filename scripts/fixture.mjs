import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const fixture = JSON.parse(
  fs.readFileSync(new URL('../test/api33/fixture.json', import.meta.url), 'utf8')
);

export function verifyFixture(file, expected = fixture) {
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (actual !== expected.sha256) {
    throw new Error(
      `detect-env fixture checksum mismatch: expected=${expected.sha256}, actual=${actual}`
    );
  }
  return actual;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node scripts/fixture.mjs <detect-env.apk>');
  }
  console.log(`Verified detect-env fixture: ${verifyFixture(process.argv[2])}`);
}
