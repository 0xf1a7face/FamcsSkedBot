import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { build } from '../node_modules/esbuild/lib/main.js';
const bundle = await build({entryPoints:[new URL('../src/index.ts',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],bundle:true,write:false,format:'esm',platform:'browser'});
const {default:app} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const secret = 'test-only-bot-token';
function auth(id) {
  const params = new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id})});
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256','WebAppData').update(secret).digest();
  params.set('hash',createHmac('sha256',key).update(check).digest('hex')); return `tma ${params}`;
}
test('colors preserve revisions, validate values and isolate users without any game schema',async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE miniapp_colors (telegram_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, colors_json TEXT NOT NULL DEFAULT '{}')`);
  const DB = {prepare(sql) {
    const wrap = values => ({bind:(...args) => wrap(args),first:async () => db.prepare(sql).get(...values) || null,run:async () => ({meta:{changes:Number(db.prepare(sql).run(...values).changes)}})});
    return wrap([]);
  }};
  const request = (body,id=1) => app.request('http://localhost/api/colors',{method:body ? 'PUT':'GET',headers:{Authorization:auth(id),'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)}:{})},{DB,TELEGRAM_BOT_TOKEN:secret});
  try {
    assert.equal((await (await request()).json()).revision,0);
    const document = {schemaVersion:1,colors:{'analysis::common':'#abcdef'},recentColors:[]};
    const saved = await (await request({revision:0,document})).json();
    assert.equal(saved.revision,1); assert.ok(saved.document.savedAt>0);
    assert.equal((await request({revision:0,document})).status,409);
    assert.equal((await request({revision:1,document:{...document,colors:{a:'bad'}}})).status,400);
    assert.deepEqual((await (await request(undefined,2)).json()).document.colors,{});
  } finally { db.close(); }
});
