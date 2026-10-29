import type { ExtensionContext } from '../../packages/composition/types';

export function activate(ctx: ExtensionContext) {
  // App identity is observation only, never a shared intervention selector.
  const unsubscribe = ctx.api.subscribe(event => {
    if (
      event.caller?.stack?.some(line => line.includes('com.eltavine.duckdetector.')) ||
      event.caller?.module === 'libduckdetector.so'
    ) {
      ctx.emit('duck-api-observed', { api: event.api });
    }
  });
  ctx.emit('duck-app-active', { pid: Process.id, scansStarted: 0 });
  return async () => {
    unsubscribe();
    ctx.emit('duck-app-stopped', { pid: Process.id });
  };
}
