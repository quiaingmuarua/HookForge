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
  console.error('Usage: node scripts/import/import-community-log.js <input-log> [--output FILE]');
  process.exit(1);
}

const extraArgs = args.slice(1);
const result = spawnSync(
  'node',
  ['hosts/node-cli/parse-log.js', input, '--parser', 'community', ...extraArgs],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  }
);

process.exit(result.status ?? 1);
