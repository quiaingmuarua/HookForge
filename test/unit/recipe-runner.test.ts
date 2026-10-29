import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  makeDefaultRecipeDumpPath,
  mergeRecipeConfig,
  resolveRecipeOutputPaths,
  type RecipeRun,
} from '../../hosts/node-cli/recipe-runner';
import type { TargetConfig } from '../../packages/core/types';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');

test('mergeRecipeConfig preserves base config and injects recipe selection', () => {
  const baseConfig: TargetConfig = {
    enable: ['http', 'bypass'],
    flags: {
      'ssl.quiet': false,
    },
    overrides: {
      classes: {
        Sample: { enabled: true },
      },
      symbols: {},
    },
  };

  const recipe: RecipeRun = {
    config: 'configs/targets/default.json',
    recipes: ['audit/android/focused-runtime'],
    recipeFlags: {
      'audit.rootSignals': true,
    },
  };

  const merged = mergeRecipeConfig(baseConfig, recipe);

  assert.deepEqual(merged.enable, ['http', 'bypass']);
  assert.equal(merged.flags?.['ssl.quiet'], false);
  assert.equal(merged.overrides?.classes?.Sample?.enabled, true);
  assert.deepEqual(merged.recipes?.ids, ['audit/android/focused-runtime']);
  assert.equal(merged.recipes?.flags?.['audit.rootSignals'], true);
});

test('resolveRecipeOutputPaths keeps normalized output primary and mirrors audit output', () => {
  const recipePath = path.join(projectRoot, 'configs', 'runs', 'network-observe.json');
  const recipe: RecipeRun = {
    config: 'configs/targets/default.json',
    dumpEvents: true,
    artifacts: {
      dynamicJsonlPath: '.runtime/analysis/dynamic/network-observe.jsonl',
    },
  };

  const resolved = resolveRecipeOutputPaths(projectRoot, recipePath, recipe, false, '');

  assert.equal(resolved.dumpEvents, true);
  assert.match(resolved.primaryDumpPath, /\.runtime[\\/]normalized[\\/]recipe_network-observe_/);
  assert.equal(
    resolved.mirrorDumpPath,
    path.resolve(projectRoot, '.runtime/analysis/dynamic/network-observe.jsonl')
  );
});

test('makeDefaultRecipeDumpPath stays under runtime normalized', () => {
  const dumpPath = makeDefaultRecipeDumpPath(projectRoot, 'configs/runs/root-detect.json');
  assert.match(dumpPath, /\.runtime[\\/]normalized[\\/]recipe_root-detect_/);
});
