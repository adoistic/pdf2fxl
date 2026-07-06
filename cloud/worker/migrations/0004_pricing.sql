-- Single-tier pricing (decided 2026-07-06). The batch/express distinction is gone:
-- batch OCR cannot return the bounding boxes the reflow geometry needs, so all OCR
-- runs realtime. Reflow moves 0.7 -> 0.9 credits/page to cover it; fixed stays 3.0.
-- The express surcharge is no longer applied (row kept but unused).
UPDATE config SET value = '900' WHERE key = 'rate_reflow_mcr';
UPDATE config SET value = '0' WHERE key = 'express_surcharge_mcr';
