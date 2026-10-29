import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = relative =>
  JSON.parse(fs.readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8'));
export const sdk = read('../../test/api33/fixture.json').duckSdk;
export const risk = read('./risk.json');
export const normal = read('./normal.json');
export const observe = { mode: 'observe', captureStack: true };
export const keys = Object.keys(risk.rules.properties);
export const packageName = 'com.detect.app.sample';
export const eventCode = 'extension.worker.detect-env.duck.scan';
export const phaseNames = [
  'baseline',
  'observe',
  'risk',
  'normal',
  'restored',
  'after-unload-1',
  'after-unload-2',
  'cold',
];
