-- One revisioned JSON document per authenticated Telegram user.
-- Idempotent for databases where this table was created manually.
CREATE TABLE IF NOT EXISTS miniapp_colors (
  telegram_id INTEGER PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  colors_json TEXT NOT NULL DEFAULT '{"schemaVersion":1,"savedAt":0,"colors":{},"recentColors":[]}'
);
