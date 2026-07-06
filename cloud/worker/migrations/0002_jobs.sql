-- Jobs. One row per uploaded document. Status transitions are guarded in
-- application code by conditional UPDATE ... WHERE status = ?, so a job can
-- never be finalized twice; the CHECK lists every legal state.
-- Plan 2a drives received -> preparing -> processing (hold placed) or failed;
-- later plans add the OCR and delivery transitions.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  bulk_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('reflow', 'fixed')),
  express INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN
    ('received', 'preparing', 'awaiting_ocr', 'processing', 'assembling', 'ready', 'failed')),
  title TEXT,
  page_count INTEGER,
  rate_mcr INTEGER,
  hold_id INTEGER REFERENCES credit_ledger(id),
  batch_id TEXT,
  r2_upload_key TEXT,
  r2_verbatim_key TEXT,
  r2_doc_key TEXT,
  r2_md_key TEXT,
  engine_version TEXT,
  error_public TEXT,
  error_internal TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX ix_jobs_user ON jobs(user_id);
CREATE INDEX ix_jobs_status ON jobs(status);
