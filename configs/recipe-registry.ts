import type { RecipeMeta } from '../packages/core/types';

import { meta as auditAndroidFocusedRuntime } from '../packages/recipes/audit/android/focused-runtime.meta';

export const RECIPE_REGISTRY: RecipeMeta[] = [auditAndroidFocusedRuntime];

export function getRecipeById(id: string): RecipeMeta | undefined {
  return RECIPE_REGISTRY.find(recipe => recipe.id === id);
}

export function getRecipesByIds(ids: string[]): RecipeMeta[] {
  return ids.map(id => getRecipeById(id)).filter((recipe): recipe is RecipeMeta => Boolean(recipe));
}
