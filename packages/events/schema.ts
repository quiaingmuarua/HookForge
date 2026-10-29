export type TraceEventKind = 'probe' | 'trace' | 'bypass' | 'validate' | 'error';
export type TraceEventPhase = 'enter' | 'leave' | 'instant';
export type TraceEventSource = 'recipe' | 'module' | 'host' | 'external';

export type TraceEvent = {
  ts: number;
  source: TraceEventSource;
  module: string;
  point: string;
  kind: TraceEventKind;
  phase?: TraceEventPhase;
  target?: {
    className?: string;
    methodName?: string;
    signature?: string;
    symbol?: string;
    moduleName?: string;
  };
  context?: {
    traceId?: string;
    spanId?: string;
    threadId?: number;
    processId?: number;
    layer?: 'java' | 'native' | 'objc' | 'host';
    stage?: string;
  };
  attrs?: Record<string, unknown>;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
};
