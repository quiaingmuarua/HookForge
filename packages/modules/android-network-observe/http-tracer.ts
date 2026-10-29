import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';
import { getJavaClass } from '@core/java-utils';
import { performOnJava } from '@core/java-bridge';
import { emitTraceEvent } from '@events/sink';
import type { TraceEvent } from '@events/schema';

function runtimeContext(stage: string) {
  const runtimeProcess = (
    globalThis as {
      Process?: {
        id?: number;
        getCurrentThreadId?: () => number;
      };
    }
  ).Process;

  return {
    processId: runtimeProcess?.id,
    threadId: runtimeProcess?.getCurrentThreadId?.(),
    layer: 'java' as const,
    stage,
  };
}

function truncate(value: string, max = 240) {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function stringify(value: unknown): string {
  try {
    if (value === null || value === undefined) {
      return String(value);
    }
    return String(value);
  } catch {
    return '<unprintable>';
  }
}

function safeRead<T>(reader: () => T, fallback: T): T {
  try {
    return reader();
  } catch {
    return fallback;
  }
}

function emitNetworkEvent(
  event: Omit<TraceEvent, 'ts' | 'source' | 'module'> & { ts?: number }
) {
  emitTraceEvent({
    ...event,
    ts: event.ts ?? Date.now(),
    source: 'module',
    module: 'common/http-tracer',
  });
}

function emitInstallEvent(family: string, status: 'activated' | 'failed', error?: unknown) {
  emitNetworkEvent({
    point: 'network/http/install',
    kind: status === 'activated' ? 'validate' : 'error',
    phase: 'instant',
    context: runtimeContext('network-install'),
    attrs: {
      family,
      status,
    },
    error:
      status === 'failed'
        ? {
            code: 'HTTP_TRACER_INSTALL_FAILED',
            message: String(error),
          }
        : undefined,
  });
}

function objectId(value: any): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  return safeRead(() => `${value.$h ?? value.hashCode?.() ?? stringify(value)}`, stringify(value));
}

function buildRequestAttrs(
  client: string,
  method: string,
  url: string,
  headers: string | undefined,
  body: unknown,
  captureHeaders: boolean,
  captureBodyMeta: boolean
) {
  const attrs: Record<string, unknown> = {
    client,
    method,
    url: truncate(url),
  };

  if (captureHeaders && headers) {
    attrs.headers = truncate(headers, 1200);
  }

  if (captureBodyMeta) {
    attrs.hasBody = body !== null && body !== undefined;
    if (body !== null && body !== undefined) {
      attrs.bodyClass = safeRead(() => stringify(body), '<unknown>');
      attrs.bodyContentType = safeRead(() => stringify((body as any).contentType?.()), '');
      attrs.bodyContentLength = safeRead(() => Number((body as any).contentLength?.()), -1);
    }
  }

  return attrs;
}

function buildResponseAttrs(
  client: string,
  method: string,
  url: string,
  response: any,
  headers: string | undefined,
  captureHeaders: boolean,
  captureBodyMeta: boolean
) {
  const attrs: Record<string, unknown> = {
    client,
    method,
    url: truncate(url),
    statusCode: safeRead(() => Number(response.code()), -1),
    message: truncate(safeRead(() => stringify(response.message?.()), '')),
  };

  const protocol = safeRead(() => stringify(response.protocol?.()), '');
  if (protocol) {
    attrs.protocol = protocol;
  }

  if (captureHeaders && headers) {
    attrs.headers = truncate(headers, 1200);
  }

  if (captureBodyMeta) {
    const body = safeRead(() => response.body?.(), null);
    attrs.hasBody = body !== null && body !== undefined;
    if (body !== null && body !== undefined) {
      attrs.bodyClass = safeRead(() => stringify(body), '<unknown>');
      attrs.bodyContentType = safeRead(() => stringify(body.contentType?.()), '');
      attrs.bodyContentLength = safeRead(() => Number(body.contentLength?.()), -1);
    }
  }

  return attrs;
}

function buildCronetRequestAttrs(
  state: {
    url: string;
    method: string;
    headers: Array<{ name: string; value: string }>;
    hasUploadProvider?: boolean;
  },
  captureHeaders: boolean
) {
  const attrs: Record<string, unknown> = {
    client: 'cronet',
    method: state.method,
    url: truncate(state.url),
  };

  if (captureHeaders && state.headers.length > 0) {
    attrs.headers = state.headers
      .map(header => `${header.name}: ${header.value}`)
      .join('\n')
      .slice(0, 1200);
  }

  if (state.hasUploadProvider !== undefined) {
    attrs.hasBody = state.hasUploadProvider;
  }

  return attrs;
}

function buildCronetResponseAttrs(
  state: {
    url: string;
    method: string;
  },
  info: any,
  captureHeaders: boolean
) {
  const attrs: Record<string, unknown> = {
    client: 'cronet',
    method: state.method,
    url: truncate(state.url),
    statusCode: safeRead(() => Number(info.getHttpStatusCode()), -1),
    message: truncate(safeRead(() => stringify(info.getHttpStatusText()), '')),
  };

  if (captureHeaders) {
    const headers = safeRead(() => stringify(info.getAllHeaders()), '');
    if (headers) {
      attrs.headers = truncate(headers, 1200);
    }
  }

  const negotiatedProtocol = safeRead(() => stringify(info.getNegotiatedProtocol()), '');
  if (negotiatedProtocol) {
    attrs.protocol = negotiatedProtocol;
  }

  return attrs;
}

function buildSocketConnectAttrs(socket: any, endpoint: any, timeoutMs?: number) {
  const endpointText = truncate(safeRead(() => stringify(endpoint), '<unknown>'));
  const endpointMatch = endpointText.match(/^(?:(.+?)\/)?([^/:]+|\[[^\]]+\]):(\d+)$/);
  const attrs: Record<string, unknown> = {
    client: 'socket',
    endpoint: endpointText,
  };

  const host = safeRead(() => stringify(socket.getInetAddress?.()?.getHostAddress?.()), '');
  if (host && host !== 'undefined') {
    attrs.host = host;
  } else if (endpointMatch) {
    attrs.host = endpointMatch[1] || endpointMatch[2].replace(/^\[|\]$/g, '');
  }

  const port = safeRead(() => Number(socket.getPort?.()), -1);
  if (port > 0) {
    attrs.port = port;
  } else if (endpointMatch) {
    attrs.port = Number(endpointMatch[3]);
  }

  if (typeof timeoutMs === 'number') {
    attrs.timeoutMs = timeoutMs;
  }

  return attrs;
}

function buildTlsHandshakeAttrs(client: string, socket: any) {
  const attrs: Record<string, unknown> = {
    client,
  };

  const host = safeRead(() => stringify(socket.getInetAddress?.()?.getHostAddress?.()), '');
  if (host) {
    attrs.host = host;
  }

  const port = safeRead(() => Number(socket.getPort?.()), -1);
  if (port >= 0) {
    attrs.port = port;
  }

  const session = safeRead(() => socket.getSession?.(), null);
  if (session) {
    const protocol = safeRead(() => stringify(session.getProtocol?.()), '');
    if (protocol) {
      attrs.protocol = protocol;
    }

    const cipherSuite = safeRead(() => stringify(session.getCipherSuite?.()), '');
    if (cipherSuite) {
      attrs.cipherSuite = cipherSuite;
    }

    const peerHost = safeRead(() => stringify(session.getPeerHost?.()), '');
    if (peerHost) {
      attrs.peerHost = peerHost;
    }
  }

  return attrs;
}

async function activate(ctx: Ctx) {
  const { env, log, cfg } = ctx;
  const moduleLog = makeModuleLogger('http-tracer');

  const captureBody = cfg.flags?.['http.captureBody'] === true;
  const captureHeaders = cfg.flags?.['http.captureHeaders'] !== false;
  const captureResponseHeaders = cfg.flags?.['http.captureResponseHeaders'] !== false;
  const captureBodyMeta = cfg.flags?.['http.captureBodyMeta'] !== false;

  if (env.platform === 'android' && env.javaAvailable) {
    await performOnJava(() => {
      try {
        const cronetBuilderState = new Map<
          string,
          {
            url: string;
            method: string;
            headers: Array<{ name: string; value: string }>;
            hasUploadProvider?: boolean;
          }
        >();
        const cronetRequestState = new Map<
          string,
          {
            url: string;
            method: string;
            headers: Array<{ name: string; value: string }>;
            hasUploadProvider?: boolean;
          }
        >();
        let cronetInstalled = false;

        const installCronetTracing = () => {
          if (cronetInstalled) {
            return true;
          }

          try {
            const CronetEngine = getJavaClass('org.chromium.net.CronetEngine', true);

            let builderHooksInstalled = false;
            let requestHooksInstalled = false;

            const hookCronetBuilderClass = (className: string) => {
              try {
                const BuilderClass = getJavaClass(className, true);

                try {
                  const setHttpMethod = BuilderClass.setHttpMethod.overload('java.lang.String');
                  setHttpMethod.implementation = function (method: string) {
                    const builderKey = objectId(this);
                    const current = cronetBuilderState.get(builderKey);
                    if (current) {
                      current.method = stringify(method);
                    }
                    return setHttpMethod.call(this, method);
                  };
                  builderHooksInstalled = true;
                } catch {
                  // Optional Cronet builder method.
                }

                try {
                  const addHeader = BuilderClass.addHeader.overload(
                    'java.lang.String',
                    'java.lang.String'
                  );
                  addHeader.implementation = function (name: string, value: string) {
                    const builderKey = objectId(this);
                    const current = cronetBuilderState.get(builderKey);
                    if (current) {
                      current.headers.push({
                        name: stringify(name),
                        value: stringify(value),
                      });
                    }
                    return addHeader.call(this, name, value);
                  };
                  builderHooksInstalled = true;
                } catch {
                  // Optional Cronet builder method.
                }

                try {
                  const setUploadDataProvider = BuilderClass.setUploadDataProvider.overload(
                    'org.chromium.net.UploadDataProvider',
                    'java.util.concurrent.Executor'
                  );
                  setUploadDataProvider.implementation = function (provider: any, executor: any) {
                    const builderKey = objectId(this);
                    const current = cronetBuilderState.get(builderKey);
                    if (current) {
                      current.hasUploadProvider = provider !== null && provider !== undefined;
                    }
                    return setUploadDataProvider.call(this, provider, executor);
                  };
                  builderHooksInstalled = true;
                } catch {
                  // Optional Cronet builder method.
                }

                try {
                  const build = BuilderClass.build.overload();
                  build.implementation = function () {
                    const request = build.call(this);
                    const builderKey = objectId(this);
                    const state = cronetBuilderState.get(builderKey);
                    if (state) {
                      cronetRequestState.set(objectId(request), {
                        ...state,
                        headers: [...state.headers],
                      });
                    }
                    return request;
                  };
                  builderHooksInstalled = true;
                } catch {
                  // Optional Cronet builder method.
                }
              } catch {
                // Concrete builder implementation not present in this target.
              }
            };

            const hookCronetRequestClass = (className: string) => {
              try {
                const RequestClass = getJavaClass(className, true);

                try {
                  const start = RequestClass.start.overload();
                  start.implementation = function () {
                    const requestKey = objectId(this);
                    const state = cronetRequestState.get(requestKey);
                    if (state) {
                      emitNetworkEvent({
                        point: 'network/http/request',
                        kind: 'trace',
                        phase: 'enter',
                        target: {
                          className,
                          methodName: 'start',
                          signature: '()',
                        },
                        context: runtimeContext('network-http'),
                        attrs: buildCronetRequestAttrs(state, captureHeaders),
                      });
                    }
                    return start.call(this);
                  };
                  requestHooksInstalled = true;
                } catch {
                  // Optional Cronet request method.
                }

                try {
                  const onResponseStarted = RequestClass.onResponseStarted.overload(
                    'org.chromium.net.UrlResponseInfo'
                  );
                  onResponseStarted.implementation = function (info: any) {
                    const requestKey = objectId(this);
                    const state = cronetRequestState.get(requestKey);
                    if (state) {
                      emitNetworkEvent({
                        point: 'network/http/response',
                        kind: 'trace',
                        phase: 'leave',
                        target: {
                          className,
                          methodName: 'onResponseStarted',
                          signature: '(org.chromium.net.UrlResponseInfo)',
                        },
                        context: runtimeContext('network-http'),
                        attrs: buildCronetResponseAttrs(state, info, captureResponseHeaders),
                      });
                    }
                    return onResponseStarted.call(this, info);
                  };
                  requestHooksInstalled = true;
                } catch {
                  // Internal Cronet callback path not available.
                }

                try {
                  const onFailed = RequestClass.onFailed.overload(
                    'org.chromium.net.UrlResponseInfo',
                    'org.chromium.net.CronetException'
                  );
                  onFailed.implementation = function (info: any, error: any) {
                    const requestKey = objectId(this);
                    const state = cronetRequestState.get(requestKey);
                    if (state) {
                      emitNetworkEvent({
                        point: 'network/http/failure',
                        kind: 'error',
                        phase: 'leave',
                        target: {
                          className,
                          methodName: 'onFailed',
                          signature:
                            '(org.chromium.net.UrlResponseInfo,org.chromium.net.CronetException)',
                        },
                        context: runtimeContext('network-http'),
                        attrs: {
                          client: 'cronet',
                          method: state.method,
                          url: truncate(state.url),
                          statusCode: info
                            ? safeRead(() => Number(info.getHttpStatusCode()), -1)
                            : -1,
                        },
                        error: {
                          code: 'HTTP_CALL_FAILED',
                          message: stringify(error),
                        },
                      });
                    }
                    return onFailed.call(this, info, error);
                  };
                  requestHooksInstalled = true;
                } catch {
                  // Internal Cronet failure path not available.
                }
              } catch {
                // Concrete request implementation not present in this target.
              }
            };

            try {
              const newUrlRequestBuilder = CronetEngine.newUrlRequestBuilder.overload(
                'java.lang.String',
                'org.chromium.net.UrlRequest$Callback',
                'java.util.concurrent.Executor'
              );

              newUrlRequestBuilder.implementation = function (
                url: string,
                callback: any,
                executor: any
              ) {
                const builder = newUrlRequestBuilder.call(this, url, callback, executor);
                cronetBuilderState.set(objectId(builder), {
                  url: stringify(url),
                  method: 'GET',
                  headers: [],
                  hasUploadProvider: false,
                });
                return builder;
              };
              builderHooksInstalled = true;
            } catch {
              // Some Cronet versions use different builder entrypoints.
            }

            hookCronetBuilderClass('org.chromium.net.UrlRequest$Builder');
            hookCronetBuilderClass('org.chromium.net.impl.CronetUrlRequestBuilderImpl');
            hookCronetBuilderClass('org.chromium.net.impl.JavaUrlRequestBuilderImpl');

            hookCronetRequestClass('org.chromium.net.UrlRequest');
            hookCronetRequestClass('org.chromium.net.impl.CronetUrlRequest');
            hookCronetRequestClass('org.chromium.net.impl.JavaUrlRequest');

            if (builderHooksInstalled || requestHooksInstalled) {
              emitInstallEvent('cronet', 'activated');
              cronetInstalled = true;
            }
          } catch {
            // Cronet not present in this target.
          }

          return cronetInstalled;
        };

        const scheduleCronetRetry = (attempt: number) => {
          if (cronetInstalled || attempt > 6) {
            return;
          }

          setTimeout(() => {
            void performOnJava(() => {
              if (installCronetTracing()) {
                moduleLog('Cronet tracer activated after deferred class load');
                return;
              }

              scheduleCronetRetry(attempt + 1);
            }).catch(() => {
              scheduleCronetRetry(attempt + 1);
            });
          }, 2000);
        };

        if (!installCronetTracing()) {
          scheduleCronetRetry(1);
        }

        try {
          getJavaClass('okhttp3.OkHttpClient', true);
          getJavaClass('okhttp3.Request', true);
          getJavaClass('okhttp3.Response', true);
          const RealCall = getJavaClass('okhttp3.RealCall', true);

          let installed = false;

          try {
            const getResponseWithInterceptorChain =
              RealCall.getResponseWithInterceptorChain.overload();

            getResponseWithInterceptorChain.implementation = function () {
              const request = this.request();
              const url = request.url().toString();
              const method = request.method();
              const requestHeaders = captureHeaders
                ? safeRead(() => request.headers().toString(), '')
                : undefined;
              const requestBody = safeRead(() => request.body(), null);

              emitNetworkEvent({
                point: 'network/http/request',
                kind: 'trace',
                phase: 'enter',
                target: {
                  className: 'okhttp3.RealCall',
                  methodName: 'getResponseWithInterceptorChain',
                  signature: '()',
                },
                context: runtimeContext('network-http'),
                attrs: buildRequestAttrs(
                  'okhttp3',
                  method,
                  url,
                  requestHeaders,
                  requestBody,
                  captureHeaders,
                  captureBodyMeta
                ),
              });

              try {
                const response = getResponseWithInterceptorChain.call(this);
                const responseHeaders = captureResponseHeaders
                  ? safeRead(() => response.headers().toString(), '')
                  : undefined;

                emitNetworkEvent({
                  point: 'network/http/response',
                  kind: 'trace',
                  phase: 'leave',
                  target: {
                    className: 'okhttp3.RealCall',
                    methodName: 'getResponseWithInterceptorChain',
                    signature: '()',
                  },
                  context: runtimeContext('network-http'),
                  attrs: buildResponseAttrs(
                    'okhttp3',
                    method,
                    url,
                    response,
                    responseHeaders,
                    captureResponseHeaders,
                    captureBodyMeta
                  ),
                });
                return response;
              } catch (error) {
                emitNetworkEvent({
                  point: 'network/http/failure',
                  kind: 'error',
                  phase: 'leave',
                  target: {
                    className: 'okhttp3.RealCall',
                    methodName: 'getResponseWithInterceptorChain',
                    signature: '()',
                  },
                  context: runtimeContext('network-http'),
                  attrs: {
                    client: 'okhttp3',
                    method,
                    url: truncate(url),
                  },
                  error: {
                    code: 'HTTP_CALL_FAILED',
                    message: String(error),
                  },
                });
                throw error;
              }
            };

            moduleLog('OkHttp 3.x interceptor-chain tracer activated');
            emitInstallEvent('okhttp3', 'activated');
            installed = true;
          } catch {
            // Internal chain method not available.
          }

          if (!installed) {
            const execute = RealCall.execute.overload();

            execute.implementation = function () {
              const request = this.request();
              const url = request.url().toString();
              const method = request.method();
              const requestHeaders = captureHeaders
                ? safeRead(() => request.headers().toString(), '')
                : undefined;
              const requestBody = safeRead(() => request.body(), null);

              moduleLog('[OkHttp3] %s %s', method, url);

              if (captureHeaders && requestHeaders) {
                moduleLog('[OkHttp3] Headers: %s', requestHeaders);
              }
              if (captureBody && requestBody) {
                moduleLog('[OkHttp3] Request body present');
              }

              emitNetworkEvent({
                point: 'network/http/request',
                kind: 'trace',
                phase: 'enter',
                target: {
                  className: 'okhttp3.RealCall',
                  methodName: 'execute',
                  signature: '()',
                },
                context: runtimeContext('network-http'),
                attrs: buildRequestAttrs(
                  'okhttp3',
                  method,
                  url,
                  requestHeaders,
                  requestBody,
                  captureHeaders,
                  captureBodyMeta
                ),
              });

              try {
                const response = execute.call(this);
                const responseHeaders = captureResponseHeaders
                  ? safeRead(() => response.headers().toString(), '')
                  : undefined;

                moduleLog('[OkHttp3] Response: %d', response.code());
                emitNetworkEvent({
                  point: 'network/http/response',
                  kind: 'trace',
                  phase: 'leave',
                  target: {
                    className: 'okhttp3.RealCall',
                    methodName: 'execute',
                    signature: '()',
                  },
                  context: runtimeContext('network-http'),
                  attrs: buildResponseAttrs(
                    'okhttp3',
                    method,
                    url,
                    response,
                    responseHeaders,
                    captureResponseHeaders,
                    captureBodyMeta
                  ),
                });
                return response;
              } catch (error) {
                emitNetworkEvent({
                  point: 'network/http/failure',
                  kind: 'error',
                  phase: 'leave',
                  target: {
                    className: 'okhttp3.RealCall',
                    methodName: 'execute',
                    signature: '()',
                  },
                  context: runtimeContext('network-http'),
                  attrs: {
                    client: 'okhttp3',
                    method,
                    url: truncate(url),
                  },
                  error: {
                    code: 'HTTP_CALL_FAILED',
                    message: String(error),
                  },
                });
                throw error;
              }
            };

            moduleLog('OkHttp 3.x execute tracer activated');
            emitInstallEvent('okhttp3', 'activated');
          }
        } catch {
          // OkHttp 3.x not present in this target.
        }

        try {
          getJavaClass('com.squareup.okhttp.OkHttpClient', true);
          const Call = getJavaClass('com.squareup.okhttp.Call', true);
          const execute = Call.execute.overload();

          execute.implementation = function () {
            const request = this.request();
            const method = request.method();
            const url = request.urlString();
            const requestHeaders = captureHeaders
              ? safeRead(() => request.headers().toString(), '')
              : undefined;

            moduleLog('[OkHttp2] %s %s', method, url);
            emitNetworkEvent({
              point: 'network/http/request',
              kind: 'trace',
              phase: 'enter',
              target: {
                className: 'com.squareup.okhttp.Call',
                methodName: 'execute',
                signature: '()',
              },
              context: runtimeContext('network-http'),
              attrs: buildRequestAttrs(
                'okhttp2',
                method,
                url,
                requestHeaders,
                safeRead(() => request.body?.(), null),
                captureHeaders,
                captureBodyMeta
              ),
            });

            try {
              const response = execute.call(this);
              const responseHeaders = captureResponseHeaders
                ? safeRead(() => response.headers().toString(), '')
                : undefined;

              moduleLog('[OkHttp2] Response: %d', response.code());
              emitNetworkEvent({
                point: 'network/http/response',
                kind: 'trace',
                phase: 'leave',
                target: {
                  className: 'com.squareup.okhttp.Call',
                  methodName: 'execute',
                  signature: '()',
                },
                context: runtimeContext('network-http'),
                attrs: buildResponseAttrs(
                  'okhttp2',
                  method,
                  url,
                  response,
                  responseHeaders,
                  captureResponseHeaders,
                  captureBodyMeta
                ),
              });
              return response;
            } catch (error) {
              emitNetworkEvent({
                point: 'network/http/failure',
                kind: 'error',
                phase: 'leave',
                target: {
                  className: 'com.squareup.okhttp.Call',
                  methodName: 'execute',
                  signature: '()',
                },
                context: runtimeContext('network-http'),
                attrs: {
                  client: 'okhttp2',
                  method,
                  url: truncate(url),
                },
                error: {
                  code: 'HTTP_CALL_FAILED',
                  message: String(error),
                },
              });
              throw error;
            }
          };

          moduleLog('OkHttp 2.x tracer activated');
          emitInstallEvent('okhttp2', 'activated');
        } catch {
          // OkHttp 2.x not present in this target.
        }

        try {
          const HttpURLConnection = getJavaClass('java.net.HttpURLConnection', true);
          const getInputStream = HttpURLConnection.getInputStream.overload();

          getInputStream.implementation = function () {
            const method = String(this.getRequestMethod());
            const url = this.getURL().toString();
            const requestHeaders = captureHeaders
              ? safeRead(() => stringify(this.getRequestProperties()), '')
              : undefined;

            moduleLog('[HttpURLConnection] %s %s', method, url);
            emitNetworkEvent({
              point: 'network/http/request',
              kind: 'trace',
              phase: 'enter',
              target: {
                className: 'java.net.HttpURLConnection',
                methodName: 'getInputStream',
                signature: '()',
              },
              context: runtimeContext('network-http'),
              attrs: buildRequestAttrs(
                'http-url-connection',
                method,
                url,
                requestHeaders,
                null,
                captureHeaders,
                false
              ),
            });

            try {
              const stream = getInputStream.call(this);
              const statusCode = this.getResponseCode();
              const responseHeaders = captureResponseHeaders
                ? safeRead(() => stringify(this.getHeaderFields()), '')
                : undefined;

              moduleLog('[HttpURLConnection] Response: %d', statusCode);
              emitNetworkEvent({
                point: 'network/http/response',
                kind: 'trace',
                phase: 'leave',
                target: {
                  className: 'java.net.HttpURLConnection',
                  methodName: 'getInputStream',
                  signature: '()',
                },
                context: runtimeContext('network-http'),
                attrs: {
                  client: 'http-url-connection',
                  method,
                  url: truncate(url),
                  statusCode,
                  headers: responseHeaders ? truncate(responseHeaders, 1200) : undefined,
                  contentType: safeRead(() => stringify(this.getContentType()), ''),
                  contentLength: safeRead(() => Number(this.getContentLengthLong()), -1),
                },
              });
              return stream;
            } catch (error) {
              emitNetworkEvent({
                point: 'network/http/failure',
                kind: 'error',
                phase: 'leave',
                target: {
                  className: 'java.net.HttpURLConnection',
                  methodName: 'getInputStream',
                  signature: '()',
                },
                context: runtimeContext('network-http'),
                attrs: {
                  client: 'http-url-connection',
                  method,
                  url: truncate(url),
                },
                error: {
                  code: 'HTTP_CALL_FAILED',
                  message: String(error),
                },
              });
              throw error;
            }
          };

          moduleLog('HttpURLConnection tracer activated');
          emitInstallEvent('http-url-connection', 'activated');
        } catch (e) {
          moduleLog('HttpURLConnection tracer failed: %s', e);
          emitInstallEvent('http-url-connection', 'failed', e);
        }

        try {
          const BasicNetwork = getJavaClass('com.android.volley.toolbox.BasicNetwork', true);
          const performRequest = BasicNetwork.performRequest.overload(
            'com.android.volley.Request'
          );

          performRequest.implementation = function (request: any) {
            const methodCode = Number(request.getMethod());
            const url = String(request.getUrl());

            moduleLog('[Volley] Method: %d, URL: %s', methodCode, url);
            emitNetworkEvent({
              point: 'network/http/request',
              kind: 'trace',
              phase: 'enter',
              target: {
                className: 'com.android.volley.toolbox.BasicNetwork',
                methodName: 'performRequest',
                signature: '(com.android.volley.Request)',
              },
              context: runtimeContext('network-http'),
              attrs: {
                client: 'volley',
                methodCode,
                url: truncate(url),
                headers: captureHeaders ? truncate(safeRead(() => stringify(request.getHeaders()), ''), 1200) : undefined,
                bodyLength: captureBodyMeta ? safeRead(() => Number(request.getBody()?.length ?? 0), -1) : undefined,
              },
            });

            try {
              const response = performRequest.call(this, request);
              moduleLog('[Volley] Response status: %d', response.statusCode);
              emitNetworkEvent({
                point: 'network/http/response',
                kind: 'trace',
                phase: 'leave',
                target: {
                  className: 'com.android.volley.toolbox.BasicNetwork',
                  methodName: 'performRequest',
                  signature: '(com.android.volley.Request)',
                },
                context: runtimeContext('network-http'),
                attrs: {
                  client: 'volley',
                  methodCode,
                  url: truncate(url),
                  statusCode: Number(response.statusCode),
                },
              });
              return response;
            } catch (error) {
              emitNetworkEvent({
                point: 'network/http/failure',
                kind: 'error',
                phase: 'leave',
                target: {
                  className: 'com.android.volley.toolbox.BasicNetwork',
                  methodName: 'performRequest',
                  signature: '(com.android.volley.Request)',
                },
                context: runtimeContext('network-http'),
                attrs: {
                  client: 'volley',
                  methodCode,
                  url: truncate(url),
                },
                error: {
                  code: 'HTTP_CALL_FAILED',
                  message: String(error),
                },
              });
              throw error;
            }
          };

          moduleLog('Volley tracer activated');
          emitInstallEvent('volley', 'activated');
        } catch {
          // Volley not present in this target.
        }

        try {
          const Socket = getJavaClass('java.net.Socket', true);

          try {
            const connect = Socket.connect.overload('java.net.SocketAddress');
            connect.implementation = function (endpoint: any) {
              emitNetworkEvent({
                point: 'network/socket/connect',
                kind: 'trace',
                phase: 'enter',
                target: {
                  className: 'java.net.Socket',
                  methodName: 'connect',
                  signature: '(java.net.SocketAddress)',
                },
                context: runtimeContext('network-socket'),
                attrs: buildSocketConnectAttrs(this, endpoint),
              });

              try {
                const result = connect.call(this, endpoint);
                emitNetworkEvent({
                  point: 'network/socket/connect',
                  kind: 'trace',
                  phase: 'leave',
                  target: {
                    className: 'java.net.Socket',
                    methodName: 'connect',
                    signature: '(java.net.SocketAddress)',
                  },
                  context: runtimeContext('network-socket'),
                  attrs: buildSocketConnectAttrs(this, endpoint),
                });
                return result;
              } catch (error) {
                emitNetworkEvent({
                  point: 'network/socket/connect',
                  kind: 'error',
                  phase: 'leave',
                  target: {
                    className: 'java.net.Socket',
                    methodName: 'connect',
                    signature: '(java.net.SocketAddress)',
                  },
                  context: runtimeContext('network-socket'),
                  attrs: buildSocketConnectAttrs(this, endpoint),
                  error: {
                    code: 'SOCKET_CONNECT_FAILED',
                    message: String(error),
                  },
                });
                throw error;
              }
            };
          } catch {
            // Optional overload not available.
          }

          try {
            const connectWithTimeout = Socket.connect.overload('java.net.SocketAddress', 'int');
            connectWithTimeout.implementation = function (endpoint: any, timeoutMs: number) {
              emitNetworkEvent({
                point: 'network/socket/connect',
                kind: 'trace',
                phase: 'enter',
                target: {
                  className: 'java.net.Socket',
                  methodName: 'connect',
                  signature: '(java.net.SocketAddress,int)',
                },
                context: runtimeContext('network-socket'),
                attrs: buildSocketConnectAttrs(this, endpoint, Number(timeoutMs)),
              });

              try {
                const result = connectWithTimeout.call(this, endpoint, timeoutMs);
                emitNetworkEvent({
                  point: 'network/socket/connect',
                  kind: 'trace',
                  phase: 'leave',
                  target: {
                    className: 'java.net.Socket',
                    methodName: 'connect',
                    signature: '(java.net.SocketAddress,int)',
                  },
                  context: runtimeContext('network-socket'),
                  attrs: buildSocketConnectAttrs(this, endpoint, Number(timeoutMs)),
                });
                return result;
              } catch (error) {
                emitNetworkEvent({
                  point: 'network/socket/connect',
                  kind: 'error',
                  phase: 'leave',
                  target: {
                    className: 'java.net.Socket',
                    methodName: 'connect',
                    signature: '(java.net.SocketAddress,int)',
                  },
                  context: runtimeContext('network-socket'),
                  attrs: buildSocketConnectAttrs(this, endpoint, Number(timeoutMs)),
                  error: {
                    code: 'SOCKET_CONNECT_FAILED',
                    message: String(error),
                  },
                });
                throw error;
              }
            };
          } catch {
            // Optional overload not available.
          }

          emitInstallEvent('socket', 'activated');
        } catch {
          // Socket base class not present in this target.
        }

        const installTlsHandshakeTracing = (className: string, client: string) => {
          try {
            const TlsClass = getJavaClass(className, true);
            const startHandshake = TlsClass.startHandshake.overload();

            startHandshake.implementation = function () {
              emitNetworkEvent({
                point: 'network/tls/handshake',
                kind: 'trace',
                phase: 'enter',
                target: {
                  className,
                  methodName: 'startHandshake',
                  signature: '()',
                },
                context: runtimeContext('network-tls'),
                attrs: buildTlsHandshakeAttrs(client, this),
              });

              try {
                const result = startHandshake.call(this);
                emitNetworkEvent({
                  point: 'network/tls/handshake',
                  kind: 'trace',
                  phase: 'leave',
                  target: {
                    className,
                    methodName: 'startHandshake',
                    signature: '()',
                  },
                  context: runtimeContext('network-tls'),
                  attrs: buildTlsHandshakeAttrs(client, this),
                });
                return result;
              } catch (error) {
                emitNetworkEvent({
                  point: 'network/tls/handshake',
                  kind: 'error',
                  phase: 'leave',
                  target: {
                    className,
                    methodName: 'startHandshake',
                    signature: '()',
                  },
                  context: runtimeContext('network-tls'),
                  attrs: buildTlsHandshakeAttrs(client, this),
                  error: {
                    code: 'TLS_HANDSHAKE_FAILED',
                    message: String(error),
                  },
                });
                throw error;
              }
            };

            emitInstallEvent(client, 'activated');
          } catch {
            // TLS implementation class not present in this target.
          }
        };

        installTlsHandshakeTracing('javax.net.ssl.SSLSocket', 'ssl-socket');
        installTlsHandshakeTracing(
          'com.android.org.conscrypt.ConscryptFileDescriptorSocket',
          'conscrypt-fd-socket'
        );
        installTlsHandshakeTracing(
          'com.android.org.conscrypt.ConscryptEngineSocket',
          'conscrypt-engine-socket'
        );
        installTlsHandshakeTracing('com.android.org.conscrypt.OpenSSLSocketImpl', 'openssl-socket');
      } catch (e) {
        moduleLog('HTTP tracer setup failed: %s', e);
        emitNetworkEvent({
          point: 'network/http/install',
          kind: 'error',
          phase: 'instant',
          context: runtimeContext('network-install'),
          error: {
            code: 'HTTP_TRACER_SETUP_FAILED',
            message: String(e),
          },
        });
      }
    });
  }

  if (env.platform === 'ios' && env.objcAvailable) {
    try {
      const NSURLSession = ObjC.classes.NSURLSession;
      if (NSURLSession) {
        const originalDataTask = NSURLSession['- dataTaskWithRequest:completionHandler:'];
        if (originalDataTask) {
          Interceptor.attach(originalDataTask.implementation, {
            onEnter(args) {
              const request = new ObjC.Object(args[2]);
              moduleLog(
                '[NSURLSession] %s %s',
                request.HTTPMethod().toString(),
                request.URL().absoluteString().toString()
              );
            },
          });
        }

        moduleLog('NSURLSession tracer activated');
      }

      const NSURLConnection = ObjC.classes.NSURLConnection;
      if (NSURLConnection) {
        const originalSendSynchronousRequest =
          NSURLConnection['+ sendSynchronousRequest:returningResponse:error:'];
        if (originalSendSynchronousRequest) {
          Interceptor.attach(originalSendSynchronousRequest.implementation, {
            onEnter(args) {
              const request = new ObjC.Object(args[2]);
              moduleLog('[NSURLConnection] %s', request.URL().absoluteString().toString());
            },
          });
        }

        moduleLog('NSURLConnection tracer activated');
      }
    } catch (e) {
      moduleLog('iOS HTTP tracer setup failed: %s', e);
    }
  }

  log('HTTP tracer module activated');
  emitNetworkEvent({
    point: 'network/http/activate',
    kind: 'validate',
    phase: 'instant',
    context: runtimeContext('network-install'),
    attrs: {
      platform: env.platform,
      captureBody,
      captureHeaders,
      captureResponseHeaders,
      captureBodyMeta,
    },
  });
}

export const meta: ModuleMeta = {
  id: 'common/http-tracer',
  selector: {
    tags: ['http', 'network', 'trace'],
  },
  priority: 10,
  activate,
};
