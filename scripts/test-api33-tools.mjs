import { spawnSync } from 'node:child_process';

const python = process.env.API33_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(
  python,
  ['-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'test/api33', '-p', 'test_*.py', '-v'],
  { stdio: 'inherit' }
);
if (result.error) {
  console.error(result.error.message);
}
process.exit(result.status ?? 1);
