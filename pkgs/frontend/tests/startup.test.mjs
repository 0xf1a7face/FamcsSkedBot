import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script id="startup-watchdog">([\s\S]*?)<\/script>/)[1];
function browser() {
  const window = new EventTarget(), document = new EventTarget();
  const panel = { hidden: true }, diagnostics = {};
  document.getElementById = id => id === 'startup-error' ? panel : diagnostics;
  let timeout, ready = 0;
  window.Telegram = { WebApp: { ready() { ready++; } } };
  vm.runInNewContext(source, { window, document, URL, Date, navigator: { onLine: true },
    location: { href: 'https://famcs.online/?tgWebAppData=private' },
    setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() { timeout = null; } });
  return { window, panel, diagnostics, expire: () => timeout?.(), ready: () => ready };
}
test('watchdog starts before blocking styles and reports a failed module without query data', () => {
  assert.ok(html.indexOf('id="startup-watchdog"') < html.indexOf('rel="stylesheet"'));
  const b = browser();
  const event = new Event('error');
  Object.defineProperty(event, 'target', { value: { src: 'https://famcs.online/src/missing.js?token=private' } });
  b.window.dispatchEvent(event); b.expire();
  assert.equal(b.panel.hidden, false); assert.equal(b.ready(), 1);
  assert.match(b.diagnostics.textContent, /missing\.js/);
  assert.doesNotMatch(b.diagnostics.textContent, /private|token|tgWebAppData/);
});
test('successful startup cancels alarm, including late startup after timeout', () => {
  for (const late of [false, true]) {
    const b = browser();
    if (late) b.expire();
    b.window.dispatchEvent(new Event('schedule-ready')); b.expire();
    assert.equal(b.panel.hidden, true);
    assert.equal(b.window.scheduleStartup.stage, 'ready');
  }
});
