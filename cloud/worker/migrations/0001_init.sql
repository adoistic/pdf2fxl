-- Users. uid is the Firebase uid, null until first sign-in (admin can
-- allocate credits to an email before the person ever logs in).
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  uid TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only credit ledger. Balance = SUM(amount_mcr) per user.
-- Amounts are integer milli-credits (1 credit = 1000 mcr).
-- kinds: allocation (admin grant/revoke), hold (negative reservation),
-- capture (0-amount marker settling a hold as charged),
-- release (positive refund settling a hold as cancelled).
-- REFERENCES clauses ARE enforced: D1 (and the vitest workers pool) runs with
-- PRAGMA foreign_keys = 1, verified 2026-07-06. Tests must create real parent
-- rows; raw sqlite3 shells default foreign_keys off, so verify there with the
-- pragma enabled.
-- datetime('now') stores UTC as 'YYYY-MM-DD HH:MM:SS' (no timezone suffix);
-- do not string-compare against ISO-8601 'Z' timestamps.
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('allocation', 'hold', 'capture', 'release')),
  amount_mcr INTEGER NOT NULL,
  job_id TEXT,
  ref_id INTEGER REFERENCES credit_ledger(id),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Sign/magnitude invariant per kind: a wrong-signed row would silently
  -- corrupt the balance (= SUM(amount_mcr) per user).
  CHECK (
    (kind = 'hold' AND amount_mcr < 0)
    OR (kind = 'capture' AND amount_mcr = 0)
    OR (kind = 'release' AND amount_mcr > 0)
    OR (kind = 'allocation' AND amount_mcr <> 0)
  ),
  -- Settlements (capture/release) must reference the hold they settle; this
  -- closes the NULL bypass of ux_ledger_settlement below (SQLite excludes
  -- NULL from unique indexes), so "settled exactly once" is fully enforced.
  CHECK (kind NOT IN ('capture', 'release') OR ref_id IS NOT NULL)
);

-- A hold can be settled exactly once (either captured or released), enforced
-- by the database, not application logic. This is the race-condition guard.
CREATE UNIQUE INDEX ux_ledger_settlement
  ON credit_ledger(ref_id)
  WHERE kind IN ('capture', 'release');

CREATE INDEX ix_ledger_user ON credit_ledger(user_id);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('rate_reflow_mcr', '700'),
  ('rate_fixed_mcr', '3000'),
  ('express_surcharge_mcr', '200'),
  ('retention_hours', '72');
