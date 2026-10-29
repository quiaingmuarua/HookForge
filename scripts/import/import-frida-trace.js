#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const args = process.argv.slice(2);
const input = args[0];

if (!input) {
  console.error('Usage: node scripts/import/import-frida-trace.js <input-log> [--output FILE]');
  process.exit(1);
}

const extraArgs = args.slice(1);
const result = spawnSync(
  'node',
  ['hosts/node-cli/parse-log.js', input, '--parser', 'frida-trace', ...extraArgs],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  }
);

process.exit(result.status ?? 1);
