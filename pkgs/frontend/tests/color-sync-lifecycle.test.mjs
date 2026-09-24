import test from 'node:test';
import assert from 'node:assert/strict';
import { setupCloudColors } from '../src/cloud-colors.js';
import { subjectTeacherColorKey, teacherSurnames } from '../src/lesson-color-key.js';

const doc = (colors = {}) => ({ schemaVersion: 1, savedAt: 1, colors, recentColors: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
test('note identity is subject text and teacher surname, ignoring initials and formatting', () => {
  const key = subjectTeacherColorKey(' Математический   анализ ', 'доц. Иванов И. И.');
  assert.equal(key, subjectTeacherColorKey('математический анализ', 'И. П. Иванов'));
  assert.equal(key, subjectTeacherColorKey('МАТЕМАТИЧЕСКИЙ АНАЛИЗ', 'иванов'));
  assert.notEqual(key, subjectTeacherColorKey('Математический анализ', 'Петров'));
  assert.notEqual(key, subjectTeacherColorKey('Алгебра', 'Иванов'));
  assert.deepEqual(JSON.parse(key), ['lesson-v3', 'математический анализ', ['иванов']]);
  assert.equal(subjectTeacherColorKey('Анализ', ''), null);
  assert.equal(subjectTeacherColorKey('', 'Иванов'), null);
  assert.notEqual(subjectTeacherColorKey('Физическая культура (плавание)', 'Иванов'), subjectTeacherColorKey('Физическая культура (бег)', 'Иванов'));
});
test('teacher surnames normalize yo, hyphens and lists without matching partial surnames', () => {
  assert.deepEqual(teacherSurnames('проф. А. Б. Соловьёв; Иванов-Петров В.В.'), ['иванов-петров', 'соловьев']);
  assert.equal(subjectTeacherColorKey('Анализ', 'Иванов, Петров'), subjectTeacherColorKey('Анализ', 'Петров / Иванов'));
  assert.notEqual(subjectTeacherColorKey('Анализ', 'Иванов'), subjectTeacherColorKey('Анализ', 'Иванова'));
});
let controllers;
function environment(t, saved = {}) {
  controllers = [];
  t.after(() => controllers.forEach(controller => controller.stop()));
  const data = { ...saved };
  const storage = Object.assign(data, {});
  Object.defineProperties(storage, {
    getItem: { value: key => data[key] ?? null },
    setItem: { value: (key, value) => { data[key] = String(value); } },
  });
  for (const [key, value] of Object.entries({ localStorage: storage, window: new EventTarget(), document: Object.assign(new EventTarget(), { hidden: false }) })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  }
  return data;
}
function server() {
  let document = doc(), revision = 0;
  const calls = [];
  return {
    calls,
    get document() { return document; },
    external(colors) { document = doc(colors); revision++; },
    async request(path, body, method = 'GET') {
      calls.push(method);
      if (body) {
        if (body.revision !== revision) throw Object.assign(new Error('conflict'), { status: 409 });
        document = body.document; revision++;
      }
      return { userId: 1, revision, document };
    },
  };
}
function setup(t, remote, options = {}) {
  const sync = setupCloudColors(null, null, { hint: () => '1', request: remote.request, ...options });
  controllers.push(sync);
  return sync;
}

test('many edits make one PUT without a preceding extra GET; no-op edit makes no write', async t => {
  environment(t); const remote = server(); const sync = setup(t, remote); await tick();
  for (const color of ['#111111', '#222222', '#333333']) sync.edit('a', color);
  await sync.sync();
  sync.edit('a', '#333333'); await sync.sync();
  assert.deepEqual(remote.calls, ['GET', 'PUT']);
  assert.equal(remote.document.colors.a, '#333333');
});

test('409 rebases local changes and deletions, preserving another device changes', async t => {
  environment(t); const remote = server(); remote.external({ a: '#111111', b: '#222222' });
  const sync = setup(t, remote); await tick();
  sync.edit('a', '#333333'); sync.edit('b', null);
  remote.external({ a: '#111111', b: '#222222', c: '#444444' });
  await sync.sync();
  assert.deepEqual(remote.document.colors, { a: '#333333', c: '#444444' });
  assert.deepEqual(remote.calls, ['GET', 'PUT', 'GET', 'PUT']);
});

test('edit arriving during PUT stays pending after acknowledgement', async t => {
  const data = environment(t); const remote = server(); let release;
  const sync = setup(t, remote, { request: async (...args) => {
    if (args[2] === 'PUT') await new Promise(resolve => { release = resolve; });
    return remote.request(...args);
  } });
  await tick(); sync.edit('a', '#111111'); const running = sync.sync(); await tick();
  sync.edit('a', '#222222'); release(); await running;
  assert.equal(sync.getColors().a, '#222222');
  assert.equal(JSON.parse(data['colors:account:1']).pending.a.value, '#222222');
  const next = sync.sync(); await tick(); release(); await next;
  assert.equal(remote.document.colors.a, '#222222');
});

test('failed save survives restart and retries from durable pending edits', async t => {
  const data = environment(t); const remote = server(); let fail = true;
  const sync = setup(t, remote, { request: (...args) => args[2] === 'PUT' && fail ? Promise.reject(new Error('offline')) : remote.request(...args) });
  await tick(); sync.edit('a', '#abcdef'); await sync.sync(); sync.stop();
  assert.equal(JSON.parse(data['colors:account:1']).pending.a.value, '#abcdef');
  fail = false; setup(t, remote); await tick();
  assert.equal(remote.document.colors.a, '#abcdef');
  assert.deepEqual(JSON.parse(data['colors:account:1']).pending, {});
});

test('legacy import does not restore a deletion made while initial GET is pending', async t => {
  environment(t, { 'lessonColors:v1': JSON.stringify({ old: '#111111' }), 'colors:account:1': JSON.stringify({ document: doc({ old: '#111111' }) }) });
  const remote = server(); let release;
  const sync = setup(t, remote, { request: async (...args) => {
    if (!args[1]) await new Promise(resolve => { release = resolve; });
    return remote.request(...args);
  } });
  sync.edit('old', null); release(); await tick();
  assert.deepEqual(remote.document.colors, {});
});

test('legacy cache cannot be imported again for another user', async t => {
  environment(t, { 'colors:legacy-owner:v2': '2', 'lessonColors:v1': JSON.stringify({ other: '#abcdef' }) });
  const remote = server(); const sync = setup(t, remote); await tick();
  assert.deepEqual(sync.getColors(), {}); assert.deepEqual(remote.calls, ['GET']);
});

test('hidden page flushes pending changes and stopped listeners cannot edit storage', async t => {
  const data = environment(t); const remote = server(); const sync = setup(t, remote); await tick();
  sync.edit('a', '#123456'); document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); await tick();
  assert.equal(remote.document.colors.a, '#123456');
  sync.stop(); const before = data['colors:account:1'];
  window.dispatchEvent(Object.assign(new Event('lesson-recent-changed'), { detail: ['#ffffff'] }));
  assert.equal(data['colors:account:1'], before);
});

test('late response after account switch never paints or uploads into the new account', async t => {
  environment(t); let uid = '1', release, paints = 0; const calls = [];
  const sync = setupCloudColors(() => paints++, null, { hint: () => uid, request: (...args) => {
    calls.push(args); return new Promise(resolve => { release = resolve; });
  } });
  controllers.push(sync); const initialPaints = paints;
  uid = '2'; release({ userId: 1, revision: 1, document: doc({ private: '#abcdef' }) }); await tick();
  assert.deepEqual(sync.getColors(), {}); assert.equal(paints, initialPaints); assert.equal(calls.length, 1);
});
