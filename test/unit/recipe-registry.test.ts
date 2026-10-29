import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPE_REGISTRY,
  getRecipeById,
  getRecipesByIds,
} from '../../configs/recipe-registry';

test('recipe registry exposes the focused Android runtime audit recipe', () => {
  const recipe = getRecipeById('audit/android/focused-runtime');

  assert.ok(recipe, 'focused runtime recipe should be registered');
  assert.ok(Array.isArray(RECIPE_REGISTRY));
  assert.ok(RECIPE_REGISTRY.some(entry => entry.id === 'audit/android/focused-runtime'));
  assert.equal(recipe?.description.includes('Focused Android runtime audit'), true);
  assert.deepEqual(getRecipesByIds(['audit/android/focused-runtime']).map(entry => entry.id), [
    'audit/android/focused-runtime',
  ]);
});
