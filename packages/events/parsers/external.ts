import { createTraceEvent } from '@events/normalize';
import { TraceEvent } from '@events/schema';

export type ExternalParserHint = 'auto' | 'frida-trace' | 'community';

function parseTaggedCommunityLine(line: string): TraceEvent | null {
  const tagged = line.match(/^\[(?<tag>[^\]]+)\]\s*(?<message>.+)$/);
  if (!tagged?.groups) {
    return null;
  }

  const { tag, message } = tagged.groups;
  const call = message.match(
    /^(?<className>[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\.(?<methodName>[A-Za-z_$][\w$<>$]*)\((?<signature>.*)\)$/
  );

  return createTraceEvent({
    source: 'external',
    module: `community:${tag}`,
    point: call ? 'call' : 'log',
    kind: 'trace',
    phase: call ? 'enter' : 'instant',
    target: call?.groups
      ? {
          className: call.groups.className,
          methodName: call.groups.methodName,
          signature: call.groups.signature,
        }
      : undefined,
    attrs: { parser: 'community', tag },
    data: call ? message : message.trim(),
  });
}

function parseFridaTraceCallLine(line: string): TraceEvent | null {
  const trimmed = line.trim();
  const call = trimmed.match(
    /^(?:(?<moduleName>[A-Za-z0-9_.-]+)!)?(?<symbol>[A-Za-z_$][\w$.:<>-]*)\((?<signature>.*)\)$/
  );
  if (!call?.groups) {
    return null;
  }

  return createTraceEvent({
    source: 'external',
    module: 'frida-trace',
    point: 'call',
    kind: 'trace',
    phase: 'enter',
    target: {
      moduleName: call.groups.moduleName,
      symbol: call.groups.symbol,
      signature: call.groups.signature,
    },
    attrs: { parser: 'frida-trace' },
    data: trimmed,
  });
}

function parseFridaTraceReturnLine(line: string): TraceEvent | null {
  const trimmed = line.trim();
  const leave = trimmed.match(
    /^(?:(?<moduleName>[A-Za-z0-9_.-]+)!)?(?<symbol>[A-Za-z_$][\w$.:<>-]*)\((?<signature>.*)\)\s*=>\s*(?<result>.+)$/
  );
  if (!leave?.groups) {
    return null;
  }

  return createTraceEvent({
    source: 'external',
    module: 'frida-trace',
    point: 'call',
    kind: 'trace',
    phase: 'leave',
    target: {
      moduleName: leave.groups.moduleName,
      symbol: leave.groups.symbol,
      signature: leave.groups.signature,
    },
    attrs: { parser: 'frida-trace', result: leave.groups.result.trim() },
    data: trimmed,
  });
}

export function normalizeExternalLine(
  line: string,
  parserHint: ExternalParserHint = 'auto'
): TraceEvent[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  const parsers =
    parserHint === 'frida-trace'
      ? [parseFridaTraceReturnLine, parseFridaTraceCallLine]
      : parserHint === 'community'
        ? [parseTaggedCommunityLine]
        : [parseFridaTraceReturnLine, parseFridaTraceCallLine, parseTaggedCommunityLine];

  for (const parser of parsers) {
    const event = parser(trimmed);
    if (event) {
      return [event];
    }
  }

  return [
    createTraceEvent({
      source: 'external',
      module: parserHint === 'auto' ? 'external:raw' : `external:${parserHint}`,
      point: 'log',
      kind: 'trace',
      phase: 'instant',
      attrs: { parser: parserHint, unparsed: true },
      data: trimmed,
    }),
  ];
}
