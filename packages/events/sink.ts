import { normalizeLogEvent } from './normalize';
import { TraceEvent } from './schema';

export function emitTraceEvent(event: TraceEvent) {
  try {
    send({
      type: 'trace-event',
      event,
    });
  } catch {
    // Ignore host transport errors inside the injected runtime.
  }
}

export function emitNormalizedLogEvent(
  namespace: string,
  message: string,
  args: unknown[] = [],
  source: TraceEvent['source'] = 'module',
  moduleOverride?: string
) {
  emitTraceEvent(normalizeLogEvent(namespace, message, args, source, moduleOverride));
}
