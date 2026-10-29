import { createTraceEvent } from '@events/normalize';
import { TraceEvent } from '@events/schema';

export const recipe = {
  id: 'probe/java/class-exists',
  description: 'Check whether a Java class is present before building a heavier hook.',
  tags: ['probe', 'java', 'classloader'],
};

export function makeClassProbeEvent(
  className: string,
  exists: boolean,
  error?: string
): TraceEvent {
  return createTraceEvent({
    source: 'recipe',
    module: recipe.id,
    point: 'class-exists',
    kind: error ? 'error' : 'probe',
    phase: 'instant',
    target: { className },
    attrs: { exists },
    error: error
      ? {
          code: 'CLASS_PROBE_FAILED',
          message: error,
        }
      : undefined,
  });
}
