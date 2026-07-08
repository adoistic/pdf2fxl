-- White-label branding add-on (2026-07-08). Hidden per user: the admin flips
-- users.branding_enabled from the backend; only then does a Settings option
-- appear where the reader can restyle the app (colors, font, logo) for
-- themselves.
ALTER TABLE users ADD COLUMN branding_enabled INTEGER NOT NULL DEFAULT 0;

-- One branding row per user. Colors are #rrggbb; font is a key into the
-- app's curated font-pair list (never raw CSS); the logo lives in R2 under
-- branding/<user_id>/logo and is streamed back through the Worker.
CREATE TABLE user_branding (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  brand_color TEXT,
  accent_color TEXT,
  background_color TEXT,
  font TEXT,
  logo_key TEXT,
  logo_type TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
