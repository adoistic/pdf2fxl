-- Emphasis enrichment add-on (+0.2 credits/page). Orthogonal to mode: a job can
-- run reflow or fixed with or without emphasis recovery.
ALTER TABLE jobs ADD COLUMN enrich INTEGER NOT NULL DEFAULT 0;
-- Per-page surcharge, snapshotted at count/start so the hold and any later refund
-- always agree even if the config rate changes between them. NULL until counted;
-- 0 when the add-on is off.
ALTER TABLE jobs ADD COLUMN enrich_rate_mcr INTEGER;

-- The partial surcharge refund (for pages that failed enrichment) is a positive
-- allocation row with created_by='system'. This partial unique index makes
-- "at most one system refund per job" a database guarantee, so a future code path
-- that also inserts a system allocation for a job fails loudly instead of
-- silently breaking this refund's idempotency. Holds (kind='hold') and admin
-- allocations (created_by = an email) are excluded by the predicate.
CREATE UNIQUE INDEX ux_ledger_system_refund ON credit_ledger(job_id)
  WHERE kind = 'allocation' AND created_by = 'system';

-- Surcharge rate (0.2 credits) and the OpenRouter model id. enrich_model is empty
-- until the admin sets it; an empty model disables the add-on end to end.
INSERT INTO config (key, value) VALUES ('rate_enrich_mcr', '200');
INSERT INTO config (key, value) VALUES ('enrich_model', '');
