import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { requestJson } from '../src/request.js';
import { teacherSchedule } from '../src/schedule-modes.js';
import { initializeTelegramWebApp } from '../src/telegram.js';
import { API_ROOT } from '../src/api-root.js';
import { subjectTeacherColorKey } from '../src/lesson-color-key.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('same subject and professor share notes across groups, subgroups and teacher mode', () => {
  const a = app();
  a.run(`
    const colorStore = {};
    cloudColors = { getColors: () => colorStore, edit(key, value) { colorStore[key] = value; } };
    const card = { dataset: {}, children: [], classList: { toggle() {} },
      style: { removeProperty(key) { delete this[key]; }, setProperty(key, value) { this[key] = value; } } };
    prepareLessonColor(card, 'Анализ', 'subgroup-a', 'Иванов И.И.');
    saveLessonColor('Анализ', 'subgroup-a', '#abcdef', card.dataset.lessonProfessor);
    appState.currentGroup = '3'; appState.displayedGroup = '3';
    prepareLessonColor(card, 'Анализ', 'common', 'И. И. Иванов');
    applyLessonEdge(card);
  `);
  assert.equal(a.run('card.style["--lesson-edge-color"]'), '#abcdef');
  a.run("scheduleMode = 'teacher'; selectedTeacher = 'Иванов'; prepareLessonColor(card, 'Анализ', 'subgroup-b', 'Иванов'); applyLessonEdge(card)");
  assert.equal(a.run('card.style["--lesson-edge-color"]'), '#abcdef');
  a.run("prepareLessonColor(card, 'Анализ', 'common', 'Петров'); applyLessonEdge(card)");
  assert.equal(a.run('card.style["--lesson-edge-color"]'), undefined);
  a.run("saveLessonColor('Анализ', 'common', '#112233', 'Петров')");
  assert.equal(a.run("getLessonColor('Анализ', 'common', 'Петров')"), '#112233');
  assert.equal(a.run("getLessonColor('Анализ', 'common', 'Иванов')"), '#abcdef');
  assert.equal(a.run("getLessonColor('Алгебра', 'common', 'Иванов')"), null);
});

function app() {
  const requests = [], rendered = [], loading = [], errors = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', options: [], classList: { add() {}, remove() {}, toggle() {} },
      appendChild(option) { this.options.push(option); },
      set innerHTML(value) { this.options = []; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, URL, Event, API_ROOT, subjectTeacherColorKey, requestAnimationFrame() {},
    window: { addEventListener() {} },
    document: { readyState: 'loading', addEventListener() {}, getElementById: element, createElement: () => ({}) },
    requestJson(url, options) { const pending = deferred(); requests.push({ url: String(url), options, ...pending }); return pending.promise; },
    safeGetStorage: () => null, readJsonStorage: () => null, writeJsonStorage() {}, safeRemoveStorage() {}, safeSetStorage() {},
    setStaleNotice() {}, showToast() {}, teacherSchedule, initializeTelegramWebApp() {},
    rendered, loading, errors,
  });
  const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8').replace(/import[\s\S]*?from\s+["'][^"']+["'];/g, '');
  vm.runInContext(source, context);
  vm.runInContext(`
    displaySchedule = data => rendered.push(data);
    showLoading = show => loading.push(show);
    showError = message => errors.push(message);
    hideError = () => {};
    syncSelectTrigger = () => {};
    scheduleMode = 'subgroup';
    appState.currentCourse = '1'; appState.currentGroup = '1';
  `, context);
  return { requests, rendered, loading, errors, run: code => vm.runInContext(code, context) };
}

test('timeout covers a stalled JSON body even if fetch ignores abort', async () => {
  let signal;
  const request = async (_, options) => { signal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; };
  await assert.rejects(requestJson('/test', {}, request, 10), /не ответил вовремя/);
  assert.equal(signal.aborted, true);
});

test('a request can succeed after an earlier timeout', async () => {
  await assert.rejects(requestJson('/test', {}, () => new Promise(() => {}), 10));
  assert.deepEqual(await requestJson('/test', {}, async () => ({ ok: true, json: async () => ({ success: true }) }), 100), { success: true });
});

test('latest teacher selection wins when responses arrive in reverse order', async () => {
  const a = app();
  a.run("scheduleMode = 'teacher'");
  const first = a.run("loadTeacher('Це')");
  const selected = a.run("loadTeacher('Цеховая')");
  assert.match(a.requests[1].url, new RegExp(encodeURIComponent('Цеховая')));
  a.requests[1].resolve({ success: true, data: { classes: [] } });
  await selected;
  a.requests[0].resolve({ success: true, data: { classes: [] } });
  await first;
  assert.deepEqual(a.rendered.map(data => data.teacher), ['Цеховая']);
});

test('teacher refresh bypasses cache, coalesces triggers and cannot replace a new selection', async () => {
  const a = app();
  a.run("scheduleMode = 'teacher'; selectedTeacher = 'Иванов'");
  const refresh = a.run('refreshCurrentSchedule()');
  await a.run('refreshCurrentSchedule()');
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].options.cache, 'no-store');
  assert.deepEqual(a.loading, []);
  const selected = a.run("loadTeacher('Петров')");
  a.requests[1].resolve({ success: true, data: { classes: [] } });
  await selected;
  a.requests[0].resolve({ success: true, data: { classes: [] } });
  await refresh;
  assert.deepEqual(a.rendered.map(data => data.teacher), ['Петров']);
  assert.equal(a.run('modeRefreshPending'), false);
});

test('failed teacher refresh keeps the displayed schedule and permits another refresh', async () => {
  const a = app();
  a.run("scheduleMode = 'teacher'; selectedTeacher = 'Иванов'");
  const refresh = a.run('refreshCurrentSchedule()');
  a.requests[0].reject(new Error('offline'));
  await refresh;
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.rendered, []);
  assert.equal(a.run('modeRefreshPending'), false);
  const retry = a.run('refreshCurrentSchedule()');
  a.requests[1].resolve({ success: true, data: { classes: [] } });
  await retry;
  assert.deepEqual(a.rendered.map(data => data.teacher), ['Иванов']);
});

test('comparison refresh uses the mode controller and coalesces activity events', async () => {
  const a = app();
  a.run("scheduleMode = 'compare'; modesController = { refreshComparison: () => requestJson('/comparison-refresh') }");
  const refresh = a.run('refreshCurrentSchedule()');
  await a.run('refreshCurrentSchedule()');
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].url, '/comparison-refresh');
  a.requests[0].resolve({});
  await refresh;
  assert.equal(a.run('modeRefreshPending'), false);
});

test('old group response cannot replace a newer request for the same group', async () => {
  const a = app();
  const first = a.run("loadSchedule('1', '1')");
  const second = a.run("loadSchedule('1', '1')");
  a.requests[0].resolve({ success: true, data: { classes: [], marker: 'old' } });
  assert.equal((await first).cancelled, true);
  assert.deepEqual(a.loading, [true, true]);
  a.requests[1].resolve({ success: true, data: { classes: [], marker: 'new' } });
  await second;
  assert.deepEqual(a.rendered.map(data => data.marker), ['new']);
  assert.deepEqual(a.loading, [true, true, false]);
});

test('group failure cannot hide teacher spinner or show an unrelated error', async () => {
  const a = app();
  const group = a.run("loadSchedule('1', '1')");
  a.run("scheduleMode = 'teacher'; ++scheduleRequest");
  const teacher = a.run("loadTeacher('Цеховая')");
  a.requests[0].reject(new Error('offline'));
  assert.equal((await group).cancelled, true);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.loading, [true, true]);
  a.requests[1].resolve({ success: true, data: { classes: [] } });
  await teacher;
  assert.deepEqual(a.loading, [true, true, false]);
});

test('course A to B to A ignores the first response for A', async () => {
  const a = app();
  const first = a.run("loadGroups('1')");
  a.run("appState.currentCourse = '2'");
  const middle = a.run("loadGroups('2')");
  a.run("appState.currentCourse = '1'");
  const latest = a.run("loadGroups('1')");
  a.requests[2].resolve({ success: true, data: { groups: [], version: 'new' } });
  await latest;
  for (const index of [0, 1]) a.requests[index].resolve({ success: true, data: { groups: [], version: 'old' } });
  await Promise.all([first, middle]);
  assert.equal(a.run('appState.currentCourseVersion'), 'new');
});

test('background refresh replacing a foreground request eventually clears its spinner', async () => {
  const a = app();
  const foreground = a.run("loadSchedule('1', '1')");
  const background = a.run("loadSchedule('1', '1', { silent: true, forceRefresh: true })");
  a.requests[1].resolve({ success: true, data: { classes: [] } });
  await background;
  a.requests[0].resolve({ success: true, data: { classes: [] } });
  await foreground;
  assert.deepEqual(a.loading, [true, false]);
});

test('offline fallback is rendered after reselecting the same group', async () => {
  const a = app();
  a.run(`
    appState.displayedCourse = '1'; appState.displayedGroup = '1';
    appState.scheduleData = null;
    readJsonStorage = () => ({ version: 'old', data: { classes: [], marker: 'cached' } });
  `);
  const pending = a.run("loadSchedule('1', '1')");
  a.requests[0].reject(new Error('offline'));
  const result = await pending;
  assert.equal(result.fromCache, true);
  assert.deepEqual(a.rendered.map(data => data.marker), ['cached']);
});

test('Telegram ready still runs if an optional UI method fails', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document, previousStyle = globalThis.getComputedStyle;
  let ready = false;
  globalThis.window = { Telegram: { WebApp: { platform: 'android', expand() { throw new Error('unsupported'); }, ready() { ready = true; } } } };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
  try { initializeTelegramWebApp(); assert.equal(ready, true); }
  finally { globalThis.window = previousWindow; globalThis.document = previousDocument; globalThis.getComputedStyle = previousStyle; }
});

test('iOS opening animation retries expansion once and handles reactivation', () => {
  const previousWindow = globalThis.window, previousDocument = globalThis.document, previousStyle = globalThis.getComputedStyle;
  const events = new Map();
  let expanded = 0;
  globalThis.window = { Telegram: { WebApp: { platform: 'ios', isExpanded: false, expand() { expanded++; }, ready() {}, onEvent: (name, callback) => events.set(name, callback) } } };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#000000' });
  try {
    initializeTelegramWebApp();
    assert.equal(expanded, 1);
    events.get('viewportChanged')({ isStateStable: false });
    assert.equal(expanded, 1);
    events.get('viewportChanged')({ isStateStable: true });
    assert.equal(expanded, 2);
    events.get('viewportChanged')({ isStateStable: true });
    assert.equal(expanded, 2);
    events.get('activated')();
    assert.equal(expanded, 3);
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; globalThis.getComputedStyle = previousStyle; }
});
