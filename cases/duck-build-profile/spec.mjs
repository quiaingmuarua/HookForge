import { normal } from '../duck-system-properties/spec.mjs';

export { sdk, packageName, eventCode, observe } from '../duck-system-properties/spec.mjs';
export const detectorIds = ['system_properties', 'virtualization'];
export const fields = {
  BRAND: ['AgentForge', 'ro.product.brand'],
  MANUFACTURER: ['AgentForge', 'ro.product.manufacturer'],
  MODEL: ['AF Lab 33 x64', 'ro.product.model'],
  DEVICE: ['af_lab_x64', 'ro.product.device'],
  PRODUCT: ['af_lab_x64', 'ro.product.name'],
  BOARD: ['af_lab_board', 'ro.product.board'],
  HARDWARE: ['af_lab_hw', 'ro.hardware'],
  TYPE: ['user', 'ro.build.type'],
  TAGS: ['release-keys', 'ro.build.tags'],
  FINGERPRINT: [null, 'ro.build.fingerprint'],
};
export const requiredSources = ['ro.build.type', 'ro.build.tags', 'ro.build.fingerprint'];
export const propertyKeys = [
  ...Object.values(fields).map(([, key]) => key),
  'ro.build.flavor',
  ...Object.keys(normal.rules.properties),
];
export const phaseNames = [
  'baseline',
  'observe',
  'properties-only',
  'fields-only',
  'inconsistent',
  'combined',
  'restored',
  'after-unload-1',
  'after-unload-2',
  'cold',
];
export const injectedPhases = phaseNames.slice(1, 7);

export function profilesFromFingerprint(fingerprint) {
  const match =
    typeof fingerprint === 'string' &&
    fingerprint.match(
      /^[^/\s]+\/[^/\s]+\/[^:\s]+:([^/\s]+)\/([^/\s]+)\/([^:\s]+):[^/\s]+\/[^\s]+$/
    );
  if (!match || match[1] !== '13') {
    throw new Error(
      'A complete API33 baseline fingerprint is required; no invented version identifiers'
    );
  }
  const buildFields = Object.fromEntries(
    Object.entries(fields).map(([name, [value]]) => [name, value])
  );
  buildFields.FINGERPRINT = `AgentForge/af_lab_x64/af_lab_x64:${match[1]}/${match[2]}/${match[3]}:user/release-keys`;
  const properties = {
    ...normal.rules.properties,
    ...Object.fromEntries(
      Object.entries(fields).map(([name, [, key]]) => [key, buildFields[name]])
    ),
    'ro.build.flavor': 'af_lab_x64-user',
  };
  const policy = rules => ({ mode: 'replace', captureStack: true, rules });
  return {
    'properties-only': policy({ properties }),
    'fields-only': policy({ buildFields }),
    inconsistent: policy({ properties, buildFields: { ...buildFields, TAGS: 'test-keys' } }),
    combined: policy({ properties, buildFields }),
  };
}
