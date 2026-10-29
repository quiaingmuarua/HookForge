import { createTraceEvent } from '@events/normalize';
import { TraceEvent } from '@events/schema';

export const recipe = {
  id: 'trace/okhttp/basic',
  description: 'Minimal OkHttp observation recipe for quick request visibility.',
  tags: ['trace', 'network', 'okhttp'],
};

export function makeOkHttpRecipeEvent(
  point: string,
  attrs: Record<string, unknown> = {}
): TraceEvent {
  return createTraceEvent({
    source: 'recipe',
    module: recipe.id,
    point,
    kind: 'trace',
    phase: 'instant',
    attrs,
  });
}
