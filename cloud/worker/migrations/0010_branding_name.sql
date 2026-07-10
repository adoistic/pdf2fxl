-- White-label product name (2026-07-10). Lets a branding-enabled reader set
-- the name the app calls itself: it drives the browser-tab <title> (was always
-- "Thothica OCR") and the logo's alt text for their account. NULL keeps the
-- standard name. Validated server-side: trimmed, length-capped, no control
-- characters (never raw HTML — it is only ever set as text/attribute).
ALTER TABLE user_branding ADD COLUMN product_name TEXT;
