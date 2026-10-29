# Event Schema

This workspace uses a lightweight normalized event model so agents do not need
to infer meaning from raw log strings alone.

The canonical TypeScript shape lives in:

- `packages/events/schema.ts`

Core shape:

```ts
type TraceEvent = {
  ts: number;
  source: 'recipe' | 'module' | 'host' | 'external';
  module: string;
  point: string;
  kind: 'probe' | 'trace' | 'bypass' | 'validate' | 'error';
  phase?: 'enter' | 'leave' | 'instant';
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
```

Guidance:

- `point` should use semantic `domain/action/subaction` naming where practical
- prefer semantic domains such as `network/http/request` over implementation-first names such as `okhttp/request`
- every structured event should carry a `phase`
- use `phase: "enter"` and `phase: "leave"` for callable hooks when both sides are available
- use `phase: "instant"` for lifecycle, install, and one-shot observation events
- prefer `target.*` for method identity and keep `attrs` for normalized values
- `context.threadId` is the minimum runtime context field for analyzable event streams
- include `context.processId` when available; reserve `traceId` and `spanId` for later flow work instead of forcing unstable IDs early

Minimal contract for analyzable runtime events:

```ts
{
  point: 'domain/action/subaction',
  phase: 'enter' | 'leave' | 'instant',
  context: {
    threadId: number,
    processId?: number,
  }
}
```

Stable network points used by the current Android network module:

- `network/http/install`
- `network/http/activate`
- `network/http/request`
- `network/http/response`
- `network/http/failure`
- `network/socket/connect`
- `network/tls/handshake`

When HTTP-level points are absent but socket or TLS points exist, the run still contains useful network evidence. Treat the gap as a missing decode layer, not as proof that the target made no network calls.

External normalization:

- `external` is used for imported `frida-trace` output or community script logs
- use [parse-log.ts](../hosts/node-cli/parse-log.ts) to convert raw text logs into JSONL events
- current lightweight parsers live in [external.ts](../packages/events/parsers/external.ts)
