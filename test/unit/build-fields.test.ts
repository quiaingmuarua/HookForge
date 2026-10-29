import assert from 'node:assert/strict';
import test from 'node:test';
import { createBuildFieldOwner } from '../../packages/modules/android-runtime-bypass/build-fields';
import {
  buildFieldNames,
  parsePolicy,
  resolveBuildFields,
} from '../../packages/modules/android-runtime-bypass/api-policy';

test('field policy restricts names and types and unifies the legacy TAGS input', () => {
  for (const buildFields of [{ SDK_INT: '33' }, { MODEL: 1 }, [], null]) {
    assert.throws(() => parsePolicy({ mode: 'replace', rules: { buildFields } }), /buildFields/);
  }
  assert.throws(
    () =>
      parsePolicy({
        mode: 'replace',
        rules: {
          buildTags: 'a',
          buildFields: { TAGS: 'b' },
        },
      }),
    /Conflicting/
  );
  const policy = parsePolicy({
    mode: 'replace',
    rules: {
      buildTags: 'same',
      buildFields: { TAGS: 'same', MODEL: 'lab' },
    },
  });
  assert.deepEqual(resolveBuildFields(policy), { TAGS: 'same', MODEL: 'lab' });
});

test('one state owner writes only selected fields and restores removed fields and original values', () => {
  const writes: string[] = [];
  const Build: any = {};
  for (const name of buildFieldNames) {
    let value = 'original-' + name;
    Build[name] = {
      get value() {
        return value;
      },
      set value(next: string) {
        writes.push(name);
        value = next;
      },
    };
  }
  const owner = createBuildFieldOwner(Build);
  owner.apply({ MODEL: 'lab', TAGS: 'release-keys' });
  assert.deepEqual(writes, ['MODEL', 'TAGS']);
  owner.apply({ TAGS: 'test-keys' });
  assert.equal(Build.MODEL.value, 'original-MODEL');
  assert.equal(Build.TAGS.value, 'test-keys');
  owner.apply({});
  assert.equal(Build.TAGS.value, 'original-TAGS');
  owner.restore();
  assert.ok(Object.values(owner.snapshot()).every(item => item.restored));
  assert.equal(Build.BRAND.value, 'original-BRAND');
});

test('partial writes roll back; a restoration/readback failure remains a failure', () => {
  let value = 'original';
  let failRestore = false;
  const Build: any = {
    MODEL: {
      get value() {
        return value;
      },
      set value(next: string) {
        if (next === 'original' && failRestore) {
          return;
        }
        value = next;
      },
    },
    TAGS: {
      get value() {
        return 'original-tags';
      },
      set value(_next: string) {
        throw new Error('write failed');
      },
    },
  };
  const owner = createBuildFieldOwner(Build);
  assert.throws(() => owner.apply({ MODEL: 'lab', TAGS: 'release' }), /write failed/);
  assert.equal(value, 'original');
  const other = createBuildFieldOwner(Build);
  other.apply({ MODEL: 'lab' });
  failRestore = true;
  assert.throws(() => other.restore(), /readback/);
  assert.equal(other.snapshot().MODEL?.restored, false);
  failRestore = false;
  other.restore();
  assert.equal(value, 'original');
});
