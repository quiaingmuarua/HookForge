import { TraceEvent } from './schema';

export function createTraceEvent(
  partial: Omit<TraceEvent, 'ts'> & { ts?: number }
): TraceEvent {
  return {
    ts: partial.ts ?? Date.now(),
    ...partial,
  };
}

export function normalizeLogEvent(
  namespace: string,
  message: string,
  args: unknown[] = [],
  source: TraceEvent['source'] = 'module',
  moduleOverride?: string
): TraceEvent {
  const runtimeProcess = (
    globalThis as {
      Process?: {
        id?: number;
        getCurrentThreadId?: () => number;
      };
    }
  ).Process;

  return createTraceEvent({
    source,
    module: moduleOverride || namespace,
    point: 'log',
    kind: 'trace',
    phase: 'instant',
    context: {
      processId: runtimeProcess?.id,
      threadId: runtimeProcess?.getCurrentThreadId?.(),
    },
    attrs: { namespace, args },
    data: message,
  });
}
