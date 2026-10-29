import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSensitiveFilesTap } from './detect-env-readiness.ts';

const visible = {
  activityFocused: true,
  windowFocused: true,
  attached: true,
  shown: true,
  enabled: true,
  bounds: { left: 20, top: 140, right: 100, bottom: 200 },
};

function timeline(read) {
  let elapsed = 0;
  let reads = 0;
  return {
    clock: {
      now: () => elapsed,
      sleep: async milliseconds => {
        elapsed += milliseconds;
      },
    },
    read: async () => {
      reads++;
      return read(elapsed);
    },
    elapsed: () => elapsed,
    reads: () => reads,
  };
}

test('a laid-out row waits through splash focus loss before returning a single tap coordinate', async () => {
  const sequence = timeline(time => ({ ...visible, windowFocused: time >= 200 }));
  assert.deepEqual(await waitForSensitiveFilesTap(sequence.read, sequence.clock), {
    x: 60,
    y: 170,
  });
  assert.equal(sequence.elapsed(), 500);
  assert.equal(sequence.reads(), 6);
});

test('focus loss and changing visible bounds restart the stability interval', async () => {
  const sequence = timeline(time => ({
    ...visible,
    activityFocused: time !== 200,
    bounds: time < 400 ? visible.bounds : { left: 40, top: 160, right: 80, bottom: 180 },
  }));
  assert.deepEqual(await waitForSensitiveFilesTap(sequence.read, sequence.clock), {
    x: 60,
    y: 170,
  });
  assert.equal(
    sequence.elapsed(),
    700,
    'equal center coordinates must not hide changing row bounds'
  );
});

test('missing, detached, disabled, hidden or empty rows time out without returning an action', async () => {
  for (const snapshot of [
    null,
    { ...visible, attached: false },
    { ...visible, enabled: false },
    { ...visible, shown: false },
    { ...visible, bounds: null },
    { ...visible, bounds: { left: 20, top: 140, right: 20, bottom: 200 } },
  ]) {
    const sequence = timeline(() => snapshot);
    await assert.rejects(
      waitForSensitiveFilesTap(sequence.read, sequence.clock),
      /focused and stable/
    );
    assert.equal(sequence.elapsed(), 15000);
  }
});
