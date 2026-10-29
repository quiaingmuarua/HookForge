import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import type { TraceEvent } from '../../packages/events/schema';

const fridaRoot = path.resolve(import.meta.dirname, '..', '..');
const samplePath = path.join(fridaRoot, 'test', 'fixtures', 'network-observe.semantic.sample.jsonl');

function loadFixtureEvents(): TraceEvent[] {
  return fs
    .readFileSync(samplePath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as TraceEvent);
}

test('focused audit semantic fixture keeps the structured event contract', () => {
  const events = loadFixtureEvents();

  assert.ok(events.length > 0, 'fixture must contain events');

  events.forEach(event => {
    assert.equal(typeof event.ts, 'number');
    assert.ok(event.source);
    assert.ok(event.module);
    assert.ok(event.point);
    assert.ok(event.kind);
    assert.ok(event.phase, `event ${event.point} must carry phase`);
    assert.match(event.point, /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$|^recipe-start$|^log$/);

    if (event.source === 'recipe' || event.source === 'module') {
      assert.ok(event.context, `runtime event ${event.point} must carry context`);
      assert.equal(
        typeof event.context?.threadId,
        'number',
        `runtime event ${event.point} must carry context.threadId`
      );
    }
  });

  const recipeStart = events.find(event => event.point === 'recipe-start');
  assert.ok(recipeStart, 'fixture must include recipe-start');
  assert.equal(recipeStart?.kind, 'validate');
  assert.equal(recipeStart?.phase, 'instant');
  assert.equal(recipeStart?.module, 'audit/android/focused-runtime');
  assert.equal(recipeStart?.context?.stage, 'recipe-lifecycle');

  const reflectionEvent = events.find(event => event.point === 'reflection/class/for-name');
  assert.ok(reflectionEvent, 'fixture must include reflection semantic event');
  assert.equal(reflectionEvent?.phase, 'enter');
  assert.equal(reflectionEvent?.target?.className, 'java.lang.Class');
  assert.equal(reflectionEvent?.target?.methodName, 'forName');
  assert.equal(reflectionEvent?.context?.layer, 'java');

  const androidIdEvent = events.find(event => event.point === 'device/android-id/read');
  assert.ok(androidIdEvent, 'fixture must include android id event');
  assert.equal(androidIdEvent?.phase, 'leave');
  assert.equal(androidIdEvent?.target?.methodName, 'getString');
  assert.ok(typeof androidIdEvent?.attrs?.value === 'string');

  const requestEvent = events.find(event => event.point === 'network/http/request');
  const responseEvent = events.find(event => event.point === 'network/http/response');
  assert.ok(requestEvent, 'fixture must include network request event');
  assert.ok(responseEvent, 'fixture must include network response event');
  assert.equal(requestEvent?.phase, 'enter');
  assert.equal(responseEvent?.phase, 'leave');
  assert.equal(requestEvent?.module, 'common/http-tracer');
  assert.equal(responseEvent?.module, 'common/http-tracer');
  assert.equal(requestEvent?.context?.stage, 'network-http');
  assert.equal(responseEvent?.context?.stage, 'network-http');
  assert.equal(typeof responseEvent?.attrs?.statusCode, 'number');
});
