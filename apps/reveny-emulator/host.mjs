import { randomUUID } from 'node:crypto';

const snapshots = new WeakMap();

function attribute(node, name) {
  const match = node.match(new RegExp('\\b' + name + '=(["\'])(.*?)\\1'));
  if (!match) {
    return null;
  }
  const entities = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
  return match[2].replace(/&(#x[\da-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (_, entity) =>
    entity[0] === '#'
      ? String.fromCodePoint(
          entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
        )
      : entities[entity.toLowerCase()]
  );
}

export function readResultUi(xml, packageName) {
  const nodes = (xml.match(/<node\b[^>]*>/g) ?? []).filter(
    node => attribute(node, 'resource-id') === packageName + ':id/result_text'
  );
  if (nodes.length !== 1) {
    throw new Error('Expected one original Reveny result_text');
  }
  const text = attribute(nodes[0], 'text');
  if (!text) {
    throw new Error('Original Reveny result is not complete');
  }
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (text !== 'Nothing detected!' && lines.some(line => !line.startsWith('- Detected '))) {
    throw new Error('Malformed original Reveny result');
  }
  return { text, findings: text === 'Nothing detected!' ? [] : lines };
}

export function snapshot(ctx, target) {
  let state = snapshots.get(ctx);
  if (!state) {
    state = { path: '/data/local/tmp/agentforge-reveny-' + randomUUID() + '.xml' };
    snapshots.set(ctx, state);
    ctx.defer(() => {
      ctx.adb(['shell', 'rm', '-f', state.path]);
      snapshots.delete(ctx);
    });
  }
  ctx.adb(['shell', 'uiautomator', 'dump', state.path]);
  const xml = ctx.adb(['exec-out', 'cat', state.path]);
  return { pid: target.pid, xml, ...readResultUi(xml, ctx.package) };
}

export async function waitReady(ctx, target) {
  while (ctx.remainingMs() > 0 && !ctx.signal.aborted) {
    const activity = ctx.adb(['shell', 'dumpsys', 'activity', 'activities']);
    if (
      /(?:mResumedActivity:|ResumedActivity:|topResumedActivity=).*com\.reveny\.emulator\.detection\.sample\/[^\s}]*MainActivity/.test(
        activity
      )
    ) {
      try {
        snapshot(ctx, target);
        return;
      } catch {
        // Repeat read-only readiness checks, never invoke a detector or clear its cache.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Original Reveny main UI/result not ready');
}
