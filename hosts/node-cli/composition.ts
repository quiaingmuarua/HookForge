import fs from 'node:fs';
import path from 'node:path';
import {
  parsePolicy,
  type AndroidApiPolicy,
} from '../../packages/modules/android-runtime-bypass/api-policy';
import { sharedHookIds } from '../../packages/composition/ownership';

export class InputError extends Error {}
export const apiGroups = [
  'file-io',
  'system-properties',
  'packages',
  'build',
  'build-fields',
  'commands',
] as const;
export type ApiGroup = (typeof apiGroups)[number];
export type Extension = {
  id: string;
  modes: ('trace' | 'replace')[];
  groups: ApiGroup[];
  owns: string[];
  entry: string;
  preset?: string;
  manifest: string;
  selected: ('trace' | 'replace')[];
};
export type App = {
  id: string;
  package: string;
  process: string;
  launch: { mode: 'spawn' | 'activity'; activity?: string; nativeBeforeResume?: boolean };
  host?: string;
  agent?: string;
  manifest: string;
};
export type Options = {
  command: string;
  serial?: string;
  spawn?: string;
  attach?: string;
  app?: string;
  trace: string[];
  replace: string[];
  extension: string[];
  script: string[];
  profile?: string;
  agent?: string;
  productionManifest?: string;
  output?: string;
  durationMs: number;
  timeoutMs: number;
};
export type Plan = {
  schemaVersion: 1;
  options: Options;
  app?: App;
  extensions: Extension[];
  scripts: string[];
  groups: ApiGroup[];
  traceGroups: ApiGroup[];
  policy: AndroidApiPolicy;
  ruleSources: Record<string, string[]>;
  ownership: Record<string, string>;
  startup?: { nativeBeforeResume: ApiGroup[]; javaAndManagedAfterProcessVerification: true };
};
const ruleGroups: Record<string, ApiGroup> = {
  fileExists: 'file-io',
  nativeFileRedirects: 'file-io',
  properties: 'system-properties',
  packagesAbsent: 'packages',
  buildTags: 'build',
  buildFields: 'build-fields',
  commandRedirects: 'commands',
  readOnlyMounts: 'commands',
};
function fail(message: string): never {
  throw new InputError(message);
}
function object(value: any, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(label + ' must be an object');
  }
  return value;
}
function fields(value: any, allowed: string[], label: string) {
  object(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(label + ': unknown field ' + key);
    }
  }
}
function strings(value: any, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
    fail(label + ' must be a string array');
  }
  return value;
}
function read(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return fail('Cannot read ' + file + ': ' + error);
  }
}
function entry(base: string, name: unknown): string {
  if (typeof name !== 'string' || !name) {
    return fail('Missing entry in ' + base);
  }
  const file = path.resolve(path.dirname(base), name);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    fail('Missing entry: ' + file);
  }
  return file;
}
export function parseComposition(
  argv: string[],
  cwd = process.env.INIT_CWD || process.cwd()
): Options {
  const result: Options = {
    command: argv[0],
    trace: [],
    replace: [],
    extension: [],
    script: [],
    durationMs: 0,
    timeoutMs: 60000,
  };
  if (!['list', 'plan', 'run'].includes(result.command)) {
    fail('Expected list, plan or run');
  }
  const single = new Set<string>();
  const paths = ['app', 'profile', 'agent', 'production-manifest', 'output', 'extension', 'script'];
  const repeated = ['trace', 'replace', 'extension', 'script'];
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index];
    const key = flag.replace(/^--/, '');
    const value = argv[++index];
    if (
      !flag.startsWith('--') ||
      !['serial', 'spawn', 'attach', 'duration-ms', 'timeout-ms', ...paths, ...repeated].includes(
        key
      ) ||
      !value ||
      value.startsWith('--')
    ) {
      fail('Invalid or incomplete argument: ' + flag);
    }
    if (!repeated.includes(key) && single.has(key)) {
      fail('Duplicate argument: ' + flag);
    }
    single.add(key);
    if (['trace', 'replace'].includes(key)) {
      const list = value.split(',');
      if (list.some(item => !item || item.trim() !== item)) {
        fail('Empty/invalid capability in ' + flag);
      }
      result[key as 'trace'].push(...list);
    } else if (key === 'extension' || key === 'script') {
      result[key].push(path.resolve(cwd, value));
    } else if (key === 'duration-ms' || key === 'timeout-ms') {
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        (key === 'timeout-ms' && Number(value) === 0)
      ) {
        fail('Invalid milliseconds: ' + flag);
      }
      result[key === 'duration-ms' ? 'durationMs' : 'timeoutMs'] = Number(value);
    } else {
      (result as any)[key === 'production-manifest' ? 'productionManifest' : key] = paths.includes(
        key
      )
        ? path.resolve(cwd, value)
        : value;
    }
  }
  result.trace = [...new Set(result.trace)];
  result.replace = [...new Set(result.replace)];
  if (Boolean(result.agent) !== Boolean(result.productionManifest)) {
    fail('--agent and --production-manifest must be paired');
  }
  const targets = [result.spawn, result.attach, result.app].filter(Boolean);
  if (targets.length > 1 || (result.command === 'run' && targets.length !== 1)) {
    fail('Choose exactly one of --spawn, --attach or --app');
  }
  if (result.command === 'run' && !result.serial) {
    fail('--serial is required');
  }
  if (result.output && fs.existsSync(result.output)) {
    fail('Output already exists: ' + result.output);
  }
  return result;
}
export function loadExtension(file: string): Extension {
  const value = read(file);
  fields(value, ['id', 'modes', 'groups', 'owns', 'entry', 'preset', 'description', 'apis'], file);
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value.id)) {
    fail('Invalid extension ID: ' + file);
  }
  const modes = strings(value.modes, 'modes');
  if (!modes.length || modes.some(item => !['trace', 'replace'].includes(item))) {
    fail('Invalid modes: ' + file);
  }
  const groups = strings(value.groups ?? [], 'groups');
  if (groups.some(item => !apiGroups.includes(item as ApiGroup))) {
    fail('Unknown shared API group: ' + file);
  }
  return {
    id: value.id,
    modes: modes as Extension['modes'],
    groups: groups as ApiGroup[],
    owns: strings(value.owns ?? [], 'owns'),
    entry: entry(file, value.entry),
    preset: value.preset ? entry(file, value.preset) : undefined,
    manifest: file,
    selected: [],
  };
}
export function loadApp(file: string): App {
  const value = read(file);
  fields(value, ['id', 'package', 'process', 'launch', 'host', 'agent'], file);
  if (![value.id, value.package].every(item => typeof item === 'string' && item.length)) {
    fail('App ID/package required');
  }
  fields(value.launch, ['mode', 'activity', 'nativeBeforeResume'], 'launch');
  if (
    !['spawn', 'activity'].includes(value.launch.mode) ||
    (value.launch.mode === 'activity' && typeof value.launch.activity !== 'string') ||
    (value.launch.activity !== undefined &&
      (typeof value.launch.activity !== 'string' || !value.launch.activity))
  ) {
    fail('Invalid App launch');
  }
  if (
    (value.launch.nativeBeforeResume !== undefined &&
      typeof value.launch.nativeBeforeResume !== 'boolean') ||
    (value.launch.nativeBeforeResume && value.launch.mode !== 'spawn')
  ) {
    fail('nativeBeforeResume requires built-in spawn');
  }
  return {
    ...value,
    process: value.process ?? value.package,
    manifest: file,
    host: value.host ? entry(file, value.host) : undefined,
    agent: value.agent ? entry(file, value.agent) : undefined,
  };
}
export function resolvePlan(options: Options, workspace: string): Plan {
  const builtins = fs
    .readdirSync(path.join(workspace, 'capabilities'))
    .filter(file => file.endsWith('.json'))
    .map(file => path.join(workspace, 'capabilities', file));
  const catalog = new Map<string, Extension>();
  for (const file of [...builtins, ...options.extension]) {
    const ext = loadExtension(file);
    if (catalog.has(ext.id)) {
      fail('Duplicate extension ID: ' + ext.id);
    }
    catalog.set(ext.id, ext);
  }
  const selected = new Set([...options.trace, ...options.replace]);
  for (const id of selected) {
    if (!catalog.has(id)) {
      fail('Unknown capability: ' + id);
    }
  }
  const extensions = [...selected].map(id => {
    const ext = catalog.get(id)!;
    ext.selected = (['trace', 'replace'] as const).filter(mode => options[mode].includes(id));
    for (const mode of ext.selected) {
      if (!ext.modes.includes(mode)) {
        fail(id + ' does not support ' + mode);
      }
    }
    return ext;
  });
  const groups = [...new Set(extensions.flatMap(ext => ext.groups))];
  const traceGroups = [
    ...new Set(extensions.filter(ext => ext.selected.includes('trace')).flatMap(ext => ext.groups)),
  ];
  const replaceGroups = new Set(
    extensions.filter(ext => ext.selected.includes('replace')).flatMap(ext => ext.groups)
  );
  const ownership: Record<string, string> = {};
  for (const group of groups) {
    ownership['shared:' + group] = 'android-api';
  }
  for (const ext of extensions) {
    for (const id of ext.owns) {
      if (id.startsWith('shared:') || sharedHookIds.includes(id) || ownership[id]) {
        fail('Hook ownership conflict: ' + id);
      }
      ownership[id] = ext.id;
    }
  }
  const policy: AndroidApiPolicy = {
    mode: options.replace.length ? 'replace' : 'observe',
    captureStack: true,
  };
  const rules: Record<string, any> = {};
  const ruleSources: Record<string, string[]> = {};
  const conflicts = new Set<string>();
  const add = (field: string, key: string, value: any, source: string, override: boolean) => {
    const id = field + (key ? ':' + key : '');
    const current = key ? rules[field]?.[key] : rules[field];
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(value) && !override) {
      conflicts.add(id);
    }
    if (override) {
      conflicts.delete(id);
    }
    if (key) {
      (rules[field] ??= {})[key] = value;
    } else {
      rules[field] = value;
    }
    (ruleSources[id] ??= []).push(
      source + (override && current !== undefined ? ' (explicit override)' : '')
    );
  };
  const merge = (input: any, source: string, override = false) => {
    fields(input, ['mode', 'captureStack', 'rules'], source);
    try {
      parsePolicy(input);
    } catch (error) {
      fail(source + ': ' + error);
    }
    if (input.mode !== policy.mode) {
      fail('Profile/preset mode conflicts with --replace: ' + source);
    }
    fields(input.rules ?? {}, Object.keys(ruleGroups), source + ' rules');
    for (const [field, values] of Object.entries(input.rules ?? {}) as [string, any][]) {
      if (
        !replaceGroups.has(ruleGroups[field]) &&
        !(field === 'buildTags' && replaceGroups.has('build-fields'))
      ) {
        fail('Intervention rule without selected --replace capability: ' + field);
      }
      if (field === 'buildTags') {
        add('buildFields', 'TAGS', values, source, override);
      } else if (
        ['fileExists', 'nativeFileRedirects', 'properties', 'buildFields'].includes(field)
      ) {
        for (const [key, value] of Object.entries(values)) {
          add(field, key, value, source, override);
        }
      } else if (field === 'commandRedirects') {
        for (const item of values) {
          add(field, JSON.stringify(item.argv), item, source, override);
        }
      } else if (Array.isArray(values)) {
        rules[field] = [...new Set([...(rules[field] ?? []), ...values])];
        for (const value of values) {
          (ruleSources[field + ':' + value] ??= []).push(source);
        }
      } else {
        add(field, '', values, source, override);
      }
    }
    if (input.captureStack !== undefined) {
      policy.captureStack = input.captureStack;
    }
  };
  for (const ext of extensions) {
    if (ext.selected.includes('replace') && ext.preset) {
      merge(read(ext.preset), ext.id);
    }
  }
  if (options.profile) {
    merge(read(options.profile), options.profile, true);
  }
  if (conflicts.size) {
    fail('Conflicting rules require explicit profile values: ' + [...conflicts].join(', '));
  }
  if (rules.commandRedirects) {
    rules.commandRedirects = Object.values(rules.commandRedirects);
  }
  // Preserve the legacy-only policy contract without widening root's scope.
  if (rules.buildFields && !replaceGroups.has('build-fields')) {
    rules.buildTags = rules.buildFields.TAGS;
    delete rules.buildFields;
  }
  if (Object.keys(rules).length) {
    policy.rules = rules;
  }
  const app = options.app ? loadApp(options.app) : undefined;
  const scripts = [...options.script, ...(app?.agent ? [app.agent] : [])];
  for (const script of scripts) {
    entry(script, path.basename(script));
  }
  if (new Set(scripts).size !== scripts.length) {
    fail('Duplicate managed script');
  }
  return {
    schemaVersion: 1,
    options,
    app,
    extensions,
    scripts,
    groups,
    traceGroups,
    policy,
    ruleSources,
    ownership,
    ...(app?.launch.nativeBeforeResume
      ? {
          startup: {
            nativeBeforeResume: groups.filter(
              group => group === 'file-io' || group === 'system-properties'
            ),
            javaAndManagedAfterProcessVerification: true as const,
          },
        }
      : {}),
  };
}
export function listCapabilities(workspace: string) {
  return fs
    .readdirSync(path.join(workspace, 'capabilities'))
    .filter(file => file.endsWith('.json'))
    .map(file => read(path.join(workspace, 'capabilities', file)));
}

export function offlineCli(argv: string[], workspace: string): number {
  try {
    const options = parseComposition(argv);
    if (options.command === 'list') {
      const local = options.extension.map(file => ({
        ...loadExtension(file),
        selected: undefined,
      }));
      console.log(JSON.stringify([...listCapabilities(workspace), ...local], null, 2));
    } else {
      console.log(JSON.stringify(resolvePlan(options, workspace), null, 2));
    }
    return 0;
  } catch (error) {
    console.error(String(error));
    return 2;
  }
}
