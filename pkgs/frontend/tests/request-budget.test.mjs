import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const source = file => readFileSync(new URL(file, import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
function browser() {
  let now = 1000000;
  const window = new EventTarget(), document = new EventTarget(), values = new Map(), timers = new Map(), intervals = [];
  document.hidden = false;
  return { window, document, timers, intervals, advance: ms => { now += ms; },
    Date: class extends Date { static now() { return now; } },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; }, clearInterval() {}, console,
  };
}
test('colors skip periodic reads in a hidden tab; edits upload and retry backs off', async () => {
  const env = browser(), calls = []; let fail = false;
  const context = vm.createContext({ ...env, accountHint: () => '1', accountRequest: async (path, body) => {
    calls.push({ path, body }); if (fail) throw new Error('offline');
    return { userId: 1, revision: 1, document: { colors: {}, recentColors: [] } };
  } });
  vm.runInContext(source('../src/cloud-colors.js') + '\nglobalThis.colors = setupCloudColors();', context);
  await tick(); assert.equal(calls.length, 1); assert.equal(env.intervals[0].ms, 600000);
  env.document.hidden = true;
  env.advance(3600000); env.intervals[0].fn(); await tick(); assert.equal(calls.length, 1);
  env.document.hidden = false;
  context.colors.edit('lesson', '#123456');
  [...env.timers.values()].find(timer => timer.ms === 3000).fn(); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].body.document.colors.lesson, '#123456');
  fail = true; context.colors.edit('lesson', '#abcdef');
  [...env.timers.values()].find(timer => timer.ms === 3000).fn(); await tick();
  assert.ok([...env.timers.values()].some(timer => timer.ms >= 20000));
  context.colors.stop();
});
