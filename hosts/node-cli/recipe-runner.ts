import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TargetConfig } from '@core/types';

export type RecipeRun = {
  id?: string;
  description?: string;
  target?: string;
  config: string;
  spawn?: boolean;
  frontmost?: boolean;
  smoke?: boolean;
  timeoutMs?: number;
  durationMs?: number;
  verbose?: boolean;
  dumpEvents?: boolean;
  dumpEventsPath?: string;
  recipes?: string[];
  recipeFlags?: Record<string, any>;
  artifacts?: {
    dynamicJsonlPath?: string;
  };
};

export function loadRecipe(recipePath: string, projectRoot: string): RecipeRun {
  const resolved = path.isAbsolute(recipePath) ? recipePath : path.resolve(projectRoot, recipePath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

export function loadTargetConfig(configPath: string, projectRoot: string): TargetConfig {
  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(projectRoot, configPath);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

export function mergeRecipeConfig(baseConfig: TargetConfig, recipe: RecipeRun): TargetConfig {
  const merged: TargetConfig = {
    ...baseConfig,
    enable: baseConfig.enable ? [...baseConfig.enable] : undefined,
    flags: { ...(baseConfig.flags || {}) },
    overrides: {
      classes: { ...(baseConfig.overrides?.classes || {}) },
      symbols: { ...(baseConfig.overrides?.symbols || {}) },
    },
  };

  if (recipe.recipes && recipe.recipes.length > 0) {
    merged.recipes = {
      ids: [...recipe.recipes],
      flags: { ...(recipe.recipeFlags || {}) },
    };
  }

  return merged;
}

export function makeDefaultRecipeDumpPath(projectRoot: string, recipePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(recipePath, path.extname(recipePath)).replace(/[^\w.-]+/g, '_');
  return path.join(projectRoot, '.runtime', 'normalized', `recipe_${baseName}_${timestamp}.jsonl`);
}

export function resolveRecipeOutputPaths(
  projectRoot: string,
  recipePath: string,
  recipe: RecipeRun,
  cliDumpEvents: boolean,
  cliDumpEventsPath: string
) {
  const dumpEvents =
    cliDumpEvents || recipe.dumpEvents === true || Boolean(recipe.artifacts?.dynamicJsonlPath);
  const primaryDumpPath = dumpEvents
    ? cliDumpEventsPath ||
      recipe.dumpEventsPath ||
      makeDefaultRecipeDumpPath(projectRoot, recipePath)
    : '';
  const mirrorDumpPath = recipe.artifacts?.dynamicJsonlPath
    ? path.resolve(projectRoot, recipe.artifacts.dynamicJsonlPath)
    : '';

  return {
    dumpEvents,
    primaryDumpPath,
    mirrorDumpPath,
  };
}

export function createRecipeEvent(
  recipe: RecipeRun,
  recipePath: string,
  point: 'recipe-start' | 'recipe-finish',
  attrs: Record<string, unknown>,
  ts: number
) {
  return {
    ts,
    source: 'host',
    module: recipe.id || `recipe:${path.basename(recipePath, path.extname(recipePath))}`,
    point,
    kind: 'validate' as const,
    phase: 'instant' as const,
    attrs: {
      recipePath,
      target: recipe.target || null,
      frontmost: recipe.frontmost === true,
      config: recipe.config,
      recipes: recipe.recipes || [],
      ...attrs,
    },
  };
}

export function writeRecipeEvents(
  filePath: string,
  recipe: RecipeRun,
  recipePath: string,
  exitCode: number,
  startedAt: number,
  endedAt: number
) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = fs.existsSync(filePath)
    ? fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
    : [];

  const startEvent = createRecipeEvent(
    recipe,
    recipePath,
    'recipe-start',
    {
      description: recipe.description || null,
    },
    startedAt
  );
  const finishEvent = createRecipeEvent(
    recipe,
    recipePath,
    'recipe-finish',
    {
      exitCode,
      status: exitCode === 0 ? 'ok' : 'failed',
      durationMs: Math.max(0, endedAt - startedAt),
    },
    endedAt
  );

  const lines = [JSON.stringify(startEvent), ...existing, JSON.stringify(finishEvent)];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

export function mirrorRecipeOutput(primaryPath: string, mirrorPath: string) {
  if (!primaryPath || !mirrorPath) {
    return;
  }

  const dir = path.dirname(mirrorPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.copyFileSync(primaryPath, mirrorPath);
}

export function createTempMergedConfig(recipePath: string, mergedConfig: TargetConfig) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-frida-recipe-'));
  const tempPath = path.join(
    tempDir,
    `${path.basename(recipePath, path.extname(recipePath))}-merged-config.json`
  );
  fs.writeFileSync(tempPath, JSON.stringify(mergedConfig, null, 2), 'utf8');
  return { tempDir, tempPath };
}
