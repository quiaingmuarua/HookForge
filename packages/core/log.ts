import { emitNormalizedLogEvent } from '@events/sink';
import type { TraceEvent } from '@events/schema';

function normalizeLogMessage(message: string): string {
  const normalized = message
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Za-z0-9[%]+/, '')
    .trim();

  return normalized || 'log';
}

function makeScopedLogger(
  ns: string,
  source: TraceEvent['source'] = 'module',
  eventModule = ns
) {
  const timestamp = () => new Date().toISOString().substring(11, 23);

  return (msg: string, ...args: any[]) => {
    const normalizedMsg = normalizeLogMessage(msg);
    const prefix = `[${timestamp()}][${ns}]`;
    console.log(`${prefix} ${normalizedMsg}`, ...args);

    // Mirror logs to the host when a host listener exists.
    try {
      send({
        type: 'log',
        namespace: ns,
        message: normalizedMsg,
        args: args,
        timestamp: Date.now(),
      });
      emitNormalizedLogEvent(ns, normalizedMsg, args, source, eventModule);
    } catch {
      // Ignore host transport errors inside the injected runtime.
    }
  };
}

export function makeLogger(ns: string) {
  return makeScopedLogger(ns);
}

export function makeModuleLogger(moduleId: string) {
  return makeLogger(`mod:${moduleId}`);
}

export function makeRecipeLogger(recipeId: string) {
  return makeScopedLogger(`recipe:${recipeId}`, 'recipe', recipeId);
}
