export const buildFieldNames = [
  'BRAND',
  'MANUFACTURER',
  'MODEL',
  'DEVICE',
  'PRODUCT',
  'BOARD',
  'HARDWARE',
  'FINGERPRINT',
  'TYPE',
  'TAGS',
] as const;
export type BuildField = (typeof buildFieldNames)[number];

/** Small, explicit API rules. No detector names, class selectors or verdicts. */
export type AndroidApiPolicy = {
  mode: 'observe' | 'replace';
  captureStack?: boolean;
  rules?: {
    fileExists?: Record<string, boolean>;
    nativeFileRedirects?: Record<string, string>;
    packagesAbsent?: string[];
    properties?: Record<string, string>;
    buildTags?: string;
    buildFields?: Partial<Record<BuildField, string>>;
    commandRedirects?: { argv: string[]; replacement: string[] }[];
    readOnlyMounts?: string[];
  };
};

/** The legacy native getter receives a PROP_VALUE_MAX (92 byte) buffer. */
export function nativePropertyLength(value: string): number {
  if (value.includes('\0')) {
    throw new Error('__system_property_get cannot deliver an embedded NUL');
  }
  const length = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, 'x').length;
  if (length > 91) {
    throw new Error('__system_property_get value exceeds its 91 UTF-8 byte limit');
  }
  return length;
}

export function parsePolicy(value: unknown): AndroidApiPolicy {
  const policy = JSON.parse(JSON.stringify(value)) as AndroidApiPolicy;
  if (!policy || !['observe', 'replace'].includes(policy.mode)) {
    throw new Error('android.api.mode must be observe or replace');
  }
  if (policy.captureStack !== undefined && typeof policy.captureStack !== 'boolean') {
    throw new Error('android.api.captureStack must be boolean');
  }
  if (
    policy.rules !== undefined &&
    (policy.rules === null || typeof policy.rules !== 'object' || Array.isArray(policy.rules))
  ) {
    throw new Error('android.api.rules must be an object');
  }
  const rules = policy.rules ?? {};
  for (const [field, type] of [
    ['fileExists', 'boolean'],
    ['nativeFileRedirects', 'string'],
    ['properties', 'string'],
  ] as const) {
    const map = rules[field];
    if (
      map !== undefined &&
      (typeof map !== 'object' ||
        map === null ||
        Array.isArray(map) ||
        Object.entries(map).some(([key, item]) => !key || typeof item !== type))
    ) {
      throw new Error(`android.api.rules.${field} must be a ${type} map`);
    }
  }
  for (const field of ['packagesAbsent', 'readOnlyMounts'] as const) {
    if (
      rules[field] !== undefined &&
      (!Array.isArray(rules[field]) ||
        rules[field]!.some(item => typeof item !== 'string' || !item))
    ) {
      throw new Error(`android.api.rules.${field} must be a string array`);
    }
  }
  if (rules.buildTags !== undefined && typeof rules.buildTags !== 'string') {
    throw new Error('android.api.rules.buildTags must be a string');
  }
  if (
    rules.buildFields !== undefined &&
    (!rules.buildFields ||
      typeof rules.buildFields !== 'object' ||
      Array.isArray(rules.buildFields) ||
      Object.entries(rules.buildFields).some(
        ([key, item]) => !buildFieldNames.includes(key as BuildField) || typeof item !== 'string'
      ))
  ) {
    throw new Error(
      'android.api.rules.buildFields requires supported Build fields and string values'
    );
  }
  resolveBuildFields(policy);
  if (
    rules.commandRedirects !== undefined &&
    (!Array.isArray(rules.commandRedirects) ||
      rules.commandRedirects.some(
        item =>
          !item ||
          [item.argv, item.replacement].some(
            args =>
              !Array.isArray(args) ||
              args.length === 0 ||
              args.some(arg => typeof arg !== 'string' || !arg)
          )
      ))
  ) {
    throw new Error('commandRedirects requires argv/replacement string arrays');
  }
  return policy;
}

/** Legacy TAGS and the field map share one write target, never two writers. */
export function resolveBuildFields(policy: AndroidApiPolicy): Partial<Record<BuildField, string>> {
  const fields = { ...policy.rules?.buildFields };
  const tags = policy.rules?.buildTags;
  if (tags !== undefined) {
    if (fields.TAGS !== undefined && fields.TAGS !== tags) {
      throw new Error('Conflicting buildTags and buildFields.TAGS in the same policy');
    }
    fields.TAGS = tags;
  }
  return fields;
}

export function transformCommandOutput(argv: string[], text: string, policy: AndroidApiPolicy) {
  if (policy.mode !== 'replace') {
    return text;
  }
  const rules = policy.rules ?? {};
  if (argv.length === 1 && ['getprop', '/system/bin/getprop'].includes(argv[0])) {
    return text
      .split('\n')
      .map(line => {
        const match = line.match(/^\[([^\]]+)\]: \[(.*)\]$/);
        return match && Object.prototype.hasOwnProperty.call(rules.properties ?? {}, match[1])
          ? `[${match[1]}]: [${rules.properties![match[1]]}]`
          : line;
      })
      .join('\n');
  }
  if (argv.length === 1 && ['mount', '/system/bin/mount'].includes(argv[0])) {
    const mounts = new Set((rules.readOnlyMounts ?? []).map(item => item.toLowerCase()));
    return text
      .split('\n')
      .map(line => {
        const match = line.match(/^(\S+ on )(\S+)( type \S+ \()([^)]*)(\).*)$/);
        if (!match || !mounts.has(match[2].toLowerCase())) {
          return line;
        }
        return `${match[1]}${match[2]}${match[3]}${match[4]
          .split(',')
          .map(flag => (flag === 'rw' ? 'ro' : flag))
          .join(',')}${match[5]}`;
      })
      .join('\n');
  }
  return text;
}
