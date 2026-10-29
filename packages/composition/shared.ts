import type { ExtensionContext } from './types';

// Shared groups are installed by the single public API owner, never by a preset.
export function activate(ctx: ExtensionContext) {
  ctx.emit('capability-active', { id: ctx.id, modes: ctx.modes });
  return async () => {
    ctx.emit('capability-stopped', { id: ctx.id });
  };
}
