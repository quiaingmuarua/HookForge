import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePolicy,
  transformCommandOutput,
} from '../../packages/modules/android-runtime-bypass/api-policy';

test('observe mode leaves output intact even when replacement rules are supplied', () => {
  const text = '[ro.example]: [original]\n';
  assert.equal(
    transformCommandOutput(['getprop'], text, {
      mode: 'observe',
      rules: { properties: { 'ro.example': 'replacement' } },
    }),
    text
  );
});

test('properties accept configured values and preserve unrelated keys and formatting', () => {
  const text = '[ro.example]: [original]\n[ro.example.extra]: [unchanged]\n[other]: [value]\n';
  for (const value of ['choice-A', 'choice-B']) {
    assert.equal(
      transformCommandOutput(['getprop'], text, {
        mode: 'replace',
        rules: { properties: { 'ro.example': value } },
      }),
      `[ro.example]: [${value}]\n[ro.example.extra]: [unchanged]\n[other]: [value]\n`
    );
  }
});

test('mount adjustment is limited to exact configured paths and rw flags', () => {
  const text = '/dev/a on /system type ext4 (rw,seclabel)\n/dev/b on /system_ext type ext4 (rw)\n';
  assert.equal(
    transformCommandOutput(['mount'], text, {
      mode: 'replace',
      rules: { readOnlyMounts: ['/system'] },
    }),
    '/dev/a on /system type ext4 (ro,seclabel)\n/dev/b on /system_ext type ext4 (rw)\n'
  );
  assert.equal(
    transformCommandOutput(['id'], text, {
      mode: 'replace',
      rules: { readOnlyMounts: ['/system'] },
    }),
    text
  );
});

test('invalid replacement values are rejected before a policy can be applied', () => {
  for (const input of [
    { mode: 'typo' },
    { mode: 'replace', rules: 'not-an-object' },
    { mode: 'replace', rules: [] },
    { mode: 'replace', rules: { fileExists: { '/file': 'false' } } },
    { mode: 'replace', rules: { properties: { property: 1 } } },
    { mode: 'replace', rules: { commandRedirects: [{ argv: [], replacement: ['command'] }] } },
  ]) {
    assert.throws(() => parsePolicy(input));
  }
});
