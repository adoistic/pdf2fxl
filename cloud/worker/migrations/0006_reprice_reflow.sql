-- Reflowable base price 0.9 -> 0.7 credits/page (Adnan, 2026-07-07): 0.9 read as
-- expensive; 0.7 keeps an okay margin and makes the +0.2 emphasis add-on an easy
-- add. Fixed stays 3.0; the emphasis surcharge stays 0.2.
UPDATE config SET value = '700' WHERE key = 'rate_reflow_mcr';
