import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { build, type Plugin } from 'esbuild';
import { InputError, type Plan } from './composition';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function buildComposition(plan: Plan, workspace: string) {
  const args = plan.options;
  let source: string;
  let manifest: any;
  if (args.agent) {
    // Keep the existing provenance verifier as the sole artifact protocol.
    const helper = await import(
      pathToFileURL(path.join(workspace, 'scripts/case-artifact.mjs')).href
    );
    let verified;
    try {
      verified = helper.productionAgent(args.agent, args.productionManifest);
    } catch (error) {
      throw new InputError(String(error));
    }
    source = verified.source;
    manifest = verified.manifest;
  } else {
    const agent = path.join(workspace, 'dist/android-api.js');
    try {
      source = fs.readFileSync(agent, 'utf8');
    } catch (error) {
      throw new InputError(
        'Cannot read built public agent ' +
          agent +
          '. Run npm run build:prod in HookForge. ' +
          error
      );
    }
  }
  return compileComposition(plan, workspace, source, manifest);
}

export async function compileComposition(
  plan: Plan,
  workspace: string,
  source: string,
  manifest?: any
) {
  const plugins: Plugin[] = [
    {
      name: 'single-public-runtime',
      setup(builder) {
        builder.onResolve({ filter: /(?:java-bridge|api-runtime)$/ }, args => ({
          path: args.path,
          namespace: 'public-runtime',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'public-runtime' }, () => ({
          contents:
            'export const { Java, initializeJavaClassLoader, performOnJava, androidApi } = AgentForgeAndroidApi;',
          loader: 'js',
        }));
      },
    },
  ];
  const modules = [
    ...plan.extensions.map(ext => ({ id: ext.id, modes: ext.selected, entry: ext.entry })),
    ...plan.scripts.map((entry, index) => ({
      id: plan.app?.agent === entry ? plan.app.id : 'script-' + index,
      modes: [],
      entry,
    })),
  ];
  if (new Set(modules.map(item => item.id)).size !== modules.length) {
    throw new InputError('Duplicate managed runtime ID');
  }
  const buildOptions = {
    bundle: true,
    write: false,
    platform: 'neutral' as const,
    target: 'es2020',
    tsconfig: path.join(workspace, 'tsconfig.json'),
    plugins,
    logLevel: 'silent' as const,
  };
  // Validate the compiled public export, including re-exports, before any ADB.
  for (const entry of new Set(modules.map(item => item.entry))) {
    const checked = await build({
      ...buildOptions,
      entryPoints: [entry],
      format: 'esm',
      metafile: true,
    });
    if (
      !Object.values(checked.metafile!.outputs).some(output => output.exports.includes('activate'))
    ) {
      throw new InputError('Managed script must export activate(ctx): ' + entry);
    }
  }
  const imports = modules.map(
    (item, index) =>
      'import * as m' + index + ' from ' + JSON.stringify(item.entry.replace(/\\/g, '/')) + ';'
  );
  const runtime = path.join(workspace, 'packages/composition/runtime.ts').replace(/\\/g, '/');
  const built = await build({
    ...buildOptions,
    format: 'iife',
    metafile: true,
    stdin: {
      contents: [
        ...imports,
        `import { registerComposition } from ${JSON.stringify(runtime)};`,
        `registerComposition(${JSON.stringify({ groups: plan.groups, traceGroups: plan.traceGroups })}, ${JSON.stringify(plan.policy)}, ${JSON.stringify(plan.ownership)}, [${modules.map((item, index) => `{id:${JSON.stringify(item.id)},modes:${JSON.stringify(item.modes)},module:m${index}}`).join(',')}]);`,
      ].join('\n'),
      resolveDir: workspace,
      loader: 'ts',
    },
  });
  const extensions = built.outputFiles![0].text;
  const full = source + '\n' + extensions;
  return {
    source,
    extensions,
    full,
    manifest,
    agentSource: plan.options.agent ? 'production-artifact' : 'local-build',
    apiAgentSha256: sha256(source),
    extensionsSha256: sha256(extensions),
    scriptSha256: sha256(full),
    inputs: Object.keys(built.metafile!.inputs),
    modules: modules.map(({ id, entry }) => ({
      id,
      entry,
      sha256: sha256(fs.readFileSync(entry)),
    })),
  };
}
