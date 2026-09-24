import type { Hono } from 'hono';
import type { AppEnvironment } from '../types';
import { authenticate, authError, readBody } from '../miniapp/auth';
const empty = () => ({ schemaVersion: 1, savedAt: 0, colors: {}, recentColors: [] });
export function registerColorRoutes(app: Hono<AppEnvironment>) {
  app.use('/api/colors', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  app.get('/api/colors', async c => {
    let user; try { user = await authenticate(c); } catch (error) { return authError(c, error); }
    const row = await c.env.DB.prepare('SELECT revision, colors_json FROM miniapp_colors WHERE telegram_id = ?').bind(user.id).first<{ revision: number; colors_json: string }>();
    return c.json({ success: true, userId: user.id, revision: row?.revision || 0, document: row ? JSON.parse(row.colors_json) : empty() });
  });
  app.put('/api/colors', async c => {
    let user; try { user = await authenticate(c); } catch (error) { return authError(c, error); }
    const body = await readBody(c, 1000000).catch(() => null);
    const doc = body?.document;
    if (!Number.isSafeInteger(body?.revision) || body.revision < 0 || !doc || doc.schemaVersion !== 1 || !doc.colors || typeof doc.colors !== 'object' || Array.isArray(doc.colors) || !Array.isArray(doc.recentColors) || doc.recentColors.length > 3 || Object.keys(doc.colors).length > 2000 ||
      Object.entries(doc.colors).some(([key, value]) => key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key) || typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) || doc.recentColors.some((v: unknown) => typeof v !== 'string' || !/^#[a-f0-9]{6}$/i.test(v))) return c.json({ success: false, error: 'Некорректные цвета.' }, 400);
    const document = { schemaVersion: 1, savedAt: Date.now(), colors: doc.colors, recentColors: doc.recentColors };
    const write = body.revision === 0
      ? await c.env.DB.prepare('INSERT INTO miniapp_colors (telegram_id, revision, colors_json) VALUES (?, 1, ?) ON CONFLICT(telegram_id) DO UPDATE SET revision = 1, colors_json = excluded.colors_json WHERE miniapp_colors.revision = 0').bind(user.id, JSON.stringify(document)).run()
      : await c.env.DB.prepare('UPDATE miniapp_colors SET colors_json = ?, revision = revision + 1 WHERE telegram_id = ? AND revision = ?').bind(JSON.stringify(document), user.id, body.revision).run();
    if (!write.meta.changes) return c.json({ success: false, error: 'Версия изменена.' }, 409);
    return c.json({ success: true, userId: user.id, revision: body.revision + 1, document });
  });
}
