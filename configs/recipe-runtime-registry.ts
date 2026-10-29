import type { RecipeRuntime } from '../packages/core/types';

import { runtime as auditAndroidFocusedRuntime } from '../packages/recipes/audit/android/focused-runtime';

const RECIPE_RUNTIME_REGISTRY: Record<string, RecipeRuntime> = {
  [auditAndroidFocusedRuntime.id]: auditAndroidFocusedRuntime,
};

export function resolveRecipeRuntime(id: string): RecipeRuntime | undefined {
  return RECIPE_RUNTIME_REGISTRY[id];
}
