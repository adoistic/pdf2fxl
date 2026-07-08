-- Translation add-on (2026-07-08). Hidden per user: the admin flips
-- users.translate_enabled from the backend; nobody else ever sees the option.
ALTER TABLE users ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0;

-- One row per translation. Pricing is snapshotted (block_words/block_mcr) at
-- submission so a config change never moves a held amount. kind 'text' is
-- pasted text; kind 'book' translates a finished job's stored document
-- structure in place. The ledger hold rides credit_ledger.job_id with the
-- translation's uuid (uuids cannot collide with job uuids).
CREATE TABLE translations (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'book')),
  job_id TEXT,
  target_language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processing', 'ready', 'failed')),
  title TEXT,
  word_count INTEGER,
  block_words INTEGER,
  block_mcr INTEGER,
  charged_mcr INTEGER,
  hold_id INTEGER REFERENCES credit_ledger(id),
  r2_source_key TEXT,
  r2_md_key TEXT,
  r2_doc_key TEXT,
  error_public TEXT,
  error_internal TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX ix_translations_user ON translations(user_id);

-- Pricing: 500 credits per 350 words, prorated per word and charged to two
-- decimal places of a credit. The cap is 2,000 words per translation while
-- this is an experiment. The model id is a config row (like enrich_model) so
-- it can be swapped without a deploy.
INSERT INTO config (key, value) VALUES
  ('translate_model', 'google/gemini-3.5-flash'),
  ('translate_block_words', '350'),
  ('translate_block_mcr', '500000'),
  ('translate_max_words', '2000');
