import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeColors, acknowledgeEdits, buildColorDocument, stageLegacyColors } from '../src/cloud-colors.js';
test('remote colors merge with pending edits and explicit deletions', () => {
  assert.deepEqual(mergeColors({ a: '#111111', b: '#222222', c: '#333333' }, {
    a: { value: '#abcdef', seq: 1 }, b: { value: null, seq: 2 },
  }), { a: '#abcdef', c: '#333333' });
});
test('late save acknowledgement cannot clear newer local edits', () => {
  const pending = { a: { value: '#111111', seq: 2 }, b: { value: null, seq: 1 } };
  acknowledgeEdits(pending, { a: { value: '#000000', seq: 1 }, b: { value: null, seq: 1 } });
  assert.deepEqual(pending, { a: { value: '#111111', seq: 2 } });
});
test('legacy device colors and recent choices are included in the upload JSON', () => {
  const local = { document: { schemaVersion: 1, savedAt: 0, colors: {}, recentColors: [] }, pending: {}, seq: 0, recent: null };
  stageLegacyColors(local, { lesson: '#ABCDEF', broken: 'red' }, ['#123456', 'bad']);
  assert.deepEqual(buildColorDocument(local.document, local.pending, local.recent), {
    schemaVersion: 1, savedAt: 0, colors: { lesson: '#abcdef' }, recentColors: ['#123456'],
  });
});
test('legacy migration can be staged again after a server read without losing local colors', () => {
  const local = { document: { schemaVersion: 1, savedAt: 10, colors: { local: '#111111' }, recentColors: [] }, pending: {}, seq: 0, recent: null };
  stageLegacyColors(local, { local: '#111111' }, []);
  assert.deepEqual(local.pending, {});
  local.document = { schemaVersion: 1, savedAt: 0, colors: {}, recentColors: [] };
  stageLegacyColors(local, { local: '#111111' }, []);
  assert.equal(local.pending.local.value, '#111111');
});
