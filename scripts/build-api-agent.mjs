import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [path.join(workspace, 'packages/modules/android-runtime-bypass/api-agent.ts')],
  outfile: path.join(workspace, 'dist/android-api.js'),
  bundle: true,
  format: 'iife',
  globalName: 'AgentForgeAndroidApi',
  platform: 'neutral',
  target: 'es2020',
  sourcemap: 'inline',
  tsconfig: path.join(workspace, 'tsconfig.json'),
  minify: process.env.NODE_ENV === 'production',
});
console.log('Built dist/android-api.js (observe/replace RPC, no APK dependency)');
