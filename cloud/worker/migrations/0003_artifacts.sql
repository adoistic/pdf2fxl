-- Artifact bookkeeping for the OCR loop. The r2 keys for verbatim, doc and md
-- already exist from 0002; this adds the figures prefix and a finish timestamp.
-- No new states: realtime processing is a single processing -> ready (or failed)
-- transition, both already in the 0002 status CHECK.
ALTER TABLE jobs ADD COLUMN r2_figures_prefix TEXT;
ALTER TABLE jobs ADD COLUMN finished_at TEXT;
