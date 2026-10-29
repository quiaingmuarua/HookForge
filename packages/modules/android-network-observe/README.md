# Android Network Observe

This capability family owns network-facing observation and bypass behavior.

Current internal strategies:

- `ssl-bypass.ts`
- `http-tracer.ts`

Current packet-capture surface in `http-tracer.ts`:

- OkHttp 3.x request and response tracing through `RealCall.getResponseWithInterceptorChain()` when available
- OkHttp 3.x fallback sync tracing through `RealCall.execute()`
- OkHttp 2.x sync tracing
- `HttpURLConnection` request and response tracing
- Volley request and response tracing
- Cronet builder/request tracing, including deferred install for late-loaded Cronet classes
- `java.net.Socket.connect(...)` transport fallback tracing through `network/socket/connect`
- `SSLSocket`/Conscrypt handshake fallback tracing through `network/tls/handshake`
- structured failure events for Java HTTP call errors

Useful flags under `configs/targets/*.json`:

- `http.captureHeaders`
- `http.captureResponseHeaders`
- `http.captureBodyMeta`
- `http.captureBody`

Interpretation rule for agents:

- Prefer `network/http/request` and `network/http/response` when present.
- If a target uses native Cronet, QUIC, or another hidden transport path, HTTP-level request objects may not appear in Java hooks.
- In that case, treat `network/socket/connect` and `network/tls/handshake` as lower-layer evidence that outbound traffic happened, then escalate only the missing HTTP decode surface.

Future OkHttp-specific telemetry, protobuf-aware inspection, native Cronet
bridging, and other network logic should be added here before creating any new
top-level module.
