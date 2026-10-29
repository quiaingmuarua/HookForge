import { resolveEnvAsync } from '@runtime/env';
import { makeLogger } from '../core/log';
import { selectModules } from '../core/match';
import { RecipeCtx, RecipeMeta, TargetConfig } from '../core/types';
import { initializeJavaClassLoader, isJavaAvailable, performOnJava } from '@runtime/java-bridge';
import { emitTraceEvent } from '@events/sink';
import { makeRecipeLogger } from '@core/log';
import { REGISTRY } from '../../configs/registry';
import { getRecipeById } from '../../configs/recipe-registry';
import { resolveRecipeRuntime } from '../../configs/recipe-runtime-registry';

const log = makeLogger('loader');
const deactivators: (() => Promise<void> | void)[] = [];
let closing = false;
let activation: Promise<void> | null = null;

rpc.exports.shutdown = async () => {
  closing = true;
  await activation?.catch(() => undefined);
  const errors: string[] = [];
  while (deactivators.length > 0) {
    try {
      await deactivators.pop()!();
    } catch (error) {
      errors.push(String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
};
// Announce cleanup before any activation can mutate App-owned fields.
send({ type: 'loader-started', shutdown: true });

/**
 * Receive target config from the host.
 * Fall back to a conservative default when nothing arrives quickly.
 */
function recvConfig(): Promise<TargetConfig> {
  return new Promise(resolve => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let cfg: TargetConfig = {
      enable: ['http', 'bypass'],
      flags: {
        'http.captureBody': false,
        'http.captureHeaders': true,
        'ssl.quiet': false,
        'info.collectMaps': false,
        'info.collectJNI': true,
        'info.collectExports': false,
      },
      overrides: {},
    };

    recv('config', msg => {
      if (resolved) {
        return;
      }
      try {
        cfg = { ...cfg, ...msg.payload };
        log('Received config from host: %s', JSON.stringify(msg.payload));
        resolved = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(cfg);
      } catch (e) {
        log('Failed to parse config: %s', e);
        resolved = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(cfg);
      }
    });

    // Many quick attach flows do not need a full host handshake.
    timeoutId = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      log('Using default config (timeout)');
      resolve(cfg);
    }, 500);
  });
}

/**
 * Report per-module activation status back to the host.
 */
function reportActivationStatus(
  type: 'module' | 'recipe',
  id: string,
  status: 'activated' | 'failed',
  error?: string
) {
  try {
    send({
      type: `${type}-status`,
      [`${type}Id`]: id,
      status,
      error,
      timestamp: Date.now(),
    });
  } catch {
    // Do not let host reporting break injected execution.
  }

  emitTraceEvent({
      ts: Date.now(),
      source: 'host',
      module: 'loader',
      point: `${type}-status`,
      kind: status === 'activated' ? 'validate' : 'error',
      phase: 'instant',
      attrs: {
        type,
        id,
        status,
      },
      error: error
        ? {
            code: `${type.toUpperCase()}_ACTIVATION_FAILED`,
            message: error,
          }
        : undefined,
    });
}

function createRecipeCtx(
  baseCtx: { env: RecipeCtx['env']; cfg: RecipeCtx['cfg']; log: RecipeCtx['log'] },
  recipe: RecipeMeta,
  recipeFlags: Record<string, any>
): RecipeCtx {
  return {
    ...baseCtx,
    recipe: {
      id: recipe.id,
      flags: recipeFlags,
      log: makeRecipeLogger(recipe.id),
      emit: event => {
        emitTraceEvent({
          ts: event.ts ?? Date.now(),
          source: 'recipe',
          module: event.module || recipe.id,
          point: event.point,
          kind: event.kind,
          phase: event.phase,
          target: event.target,
          context: event.context,
          attrs: event.attrs,
          data: event.data,
          error: event.error,
        });
      },
    },
  };
}

async function waitForJavaBridge(timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    return isJavaAvailable();
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isJavaAvailable()) {
      return true;
    }

    try {
      const ready = await new Promise<boolean>(resolve => {
        let settled = false;

        const finish = (value: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };

        const timer = setTimeout(() => finish(false), 300);

        void performOnJava(() => finish(true)).catch(() => finish(false));
      });

      if (ready) {
        return true;
      }
    } catch {
      // Keep polling until timeout.
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return isJavaAvailable();
}

async function main() {
  try {
    log('Frida module loader starting...');

    const cfg = await recvConfig();
    const javaWaitMs = Number(cfg.flags?.['runtime.waitForJavaMs'] ?? 8000);
    emitTraceEvent({
      ts: Date.now(),
      source: 'host',
      module: 'loader',
      point: 'config-received',
      kind: 'validate',
      phase: 'instant',
      attrs: {
        enable: cfg.enable || [],
        flags: cfg.flags || {},
      },
    });

    if (Process.platform === 'linux') {
      const javaReady = await waitForJavaBridge(javaWaitMs);
      if (javaReady && !(await initializeJavaClassLoader(javaWaitMs))) {
        throw new Error('Application ClassLoader was not ready before the Java deadline');
      }
      log('Java bridge wait finished: ready=%s after <= %dms', javaReady, javaWaitMs);
      emitTraceEvent({
        ts: Date.now(),
        source: 'host',
        module: 'loader',
        point: 'java-wait',
        kind: 'probe',
        phase: 'instant',
        attrs: {
          ready: javaReady,
          timeoutMs: javaWaitMs,
        },
      });
    }

    const env = await resolveEnvAsync();
    log(
      'Environment: platform=%s, arch=%s, appId=%s, appVer=%s',
      env.platform,
      env.arch,
      env.appId || 'unknown',
      env.appVer || 'unknown'
    );
    log('Java available: %s, ObjC available: %s', env.javaAvailable, env.objcAvailable);

    if (env.platform === 'android' && !env.javaAvailable) {
      log(
        'Android target has no Java bridge in this host flow; Java-layer modules will be skipped'
      );
    }

    const selectedModules = selectModules(REGISTRY, env, cfg);
    log(
      'Selected %d modules: %s',
      selectedModules.length,
      selectedModules.map(m => m.id).join(', ') || '(none)'
    );

    if (selectedModules.length === 0) {
      log('No modules selected for activation');
      emitTraceEvent({
        ts: Date.now(),
        source: 'host',
        module: 'loader',
        point: 'selection-empty',
        kind: 'probe',
        phase: 'instant',
        attrs: {
          appId: env.appId || 'unknown',
          javaAvailable: env.javaAvailable ?? false,
        },
      });
    }

    emitTraceEvent({
      ts: Date.now(),
      source: 'host',
      module: 'loader',
      point: 'selection-ready',
      kind: 'validate',
      phase: 'instant',
      attrs: {
        count: selectedModules.length,
        modules: selectedModules.map(m => m.id),
        appId: env.appId || 'unknown',
      },
    });

    const ctx = {
      env,
      cfg,
      log: makeLogger('mod'),
    };

    let activatedCount = 0;
    let failedCount = 0;

    for (const module of selectedModules) {
      try {
        log('Activating module: %s (priority: %d)', module.id, module.priority || 0);
        activation = Promise.resolve().then(async () => {
          if (closing) {
            throw new Error('Loader is shutting down');
          }
          await module.activate(ctx);
          if (module.deactivate) {
            deactivators.push(() => module.deactivate!(ctx));
          }
        });
        await activation;
        activation = null;
        log('Module activated: %s', module.id);
        reportActivationStatus('module', module.id, 'activated');
        activatedCount++;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        log('Module activation failed: %s -> %s', module.id, errorMsg);
        reportActivationStatus('module', module.id, 'failed', errorMsg);
        failedCount++;
      }
    }

    let recipeActivatedCount = 0;
    let recipeFailedCount = 0;
    const requestedRecipeIds = cfg.recipes?.ids || [];

    if (requestedRecipeIds.length > 0) {
      log('Selected %d recipes: %s', requestedRecipeIds.length, requestedRecipeIds.join(', '));
    }

    for (const recipeId of requestedRecipeIds) {
      const recipeMeta = getRecipeById(recipeId);
      if (!recipeMeta) {
        const errorMsg = `Unknown recipe id: ${recipeId}`;
        log('Recipe activation failed: %s -> %s', recipeId, errorMsg);
        reportActivationStatus('recipe', recipeId, 'failed', errorMsg);
        recipeFailedCount++;
        continue;
      }

      const recipeRuntime = resolveRecipeRuntime(recipeId);
      if (!recipeRuntime) {
        const errorMsg = `Recipe runtime not implemented: ${recipeId}`;
        log('Recipe activation failed: %s -> %s', recipeId, errorMsg);
        reportActivationStatus('recipe', recipeId, 'failed', errorMsg);
        recipeFailedCount++;
        continue;
      }

      try {
        const recipeCtx = createRecipeCtx(ctx, recipeMeta, cfg.recipes?.flags || {});
        log('Activating recipe: %s', recipeMeta.id);
        activation = Promise.resolve().then(async () => {
          if (closing) {
            throw new Error('Loader is shutting down');
          }
          await recipeRuntime.activate(recipeCtx);
          if (recipeRuntime.deactivate) {
            deactivators.push(() => recipeRuntime.deactivate!(recipeCtx));
          }
        });
        await activation;
        activation = null;
        log('Recipe activated: %s', recipeMeta.id);
        reportActivationStatus('recipe', recipeMeta.id, 'activated');
        recipeActivatedCount++;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        log('Recipe activation failed: %s -> %s', recipeMeta.id, errorMsg);
        reportActivationStatus('recipe', recipeMeta.id, 'failed', errorMsg);
        recipeFailedCount++;
      }
    }

    log(
      'Activation completed: %d/%d modules and %d/%d recipes activated',
      activatedCount,
      selectedModules.length,
      recipeActivatedCount,
      requestedRecipeIds.length
    );
    emitTraceEvent({
      ts: Date.now(),
      source: 'host',
      module: 'loader',
      point: 'activation-complete',
      kind: failedCount > 0 || recipeFailedCount > 0 ? 'error' : 'validate',
      phase: 'instant',
      attrs: {
        activatedCount,
        failedCount,
        totalModules: selectedModules.length,
        activatedRecipes: recipeActivatedCount,
        failedRecipes: recipeFailedCount,
        totalRecipes: requestedRecipeIds.length,
      },
    });

    send({
      type: 'loader-ready',
      stats: {
        totalModules: selectedModules.length,
        activatedModules: activatedCount,
        failedModules: failedCount,
        totalRecipes: requestedRecipeIds.length,
        activatedRecipes: recipeActivatedCount,
        failedRecipes: recipeFailedCount,
        environment: env,
        config: cfg,
      },
      timestamp: Date.now(),
    });

    log('Frida module loader ready');
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    log('Fatal error in loader: %s', errorMsg);
    emitTraceEvent({
      ts: Date.now(),
      source: 'host',
      module: 'loader',
      point: 'fatal-error',
      kind: 'error',
      phase: 'instant',
      error: {
        code: 'LOADER_FATAL',
        message: errorMsg,
      },
    });

    send({
      type: 'loader-error',
      error: errorMsg,
      timestamp: Date.now(),
    });
  }
}

main();
