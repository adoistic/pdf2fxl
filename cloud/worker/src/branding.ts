// White-label branding: per-user colors, font, and logo. The admin flips
// users.branding_enabled; only then does the Settings option exist for that
// account. Values are strictly validated server-side: colors are #rrggbb,
// the font is a key into the app's curated pair list (never raw CSS), and
// the logo is a size- and type-capped image in R2.

export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// Keys the frontend maps to concrete font pairs (families + webfont URL).
// Kept server-side as a whitelist so no free-form CSS ever round-trips.
export const FONT_KEYS = [
  "thothica",          // Cormorant Garamond with Teachers (the default look)
  "playfair-inter",    // Playfair Display with Inter
  "lora-source",       // Lora with Source Sans 3
  "merriweather-inter",// Merriweather with Inter
  "poppins",           // Poppins throughout
  "plex",              // IBM Plex Serif with IBM Plex Sans
  "noto",              // Noto Serif with Noto Sans
] as const;

export interface Branding {
  brandColor: string | null;
  accentColor: string | null;
  backgroundColor: string | null;
  font: string | null;
  hasLogo: boolean;
  logoType: string | null;
}

const EMPTY: Branding = {
  brandColor: null, accentColor: null, backgroundColor: null,
  font: null, hasLogo: false, logoType: null,
};

type Row = {
  brand_color: string | null; accent_color: string | null;
  background_color: string | null; font: string | null;
  logo_key: string | null; logo_type: string | null;
};

export async function brandingEnabled(db: D1Database, userId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT branding_enabled FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ branding_enabled: number }>();
  return row?.branding_enabled === 1;
}

export async function getBranding(db: D1Database, userId: number): Promise<Branding> {
  const row = await db
    .prepare(
      `SELECT brand_color, accent_color, background_color, font, logo_key, logo_type
       FROM user_branding WHERE user_id = ?1`
    )
    .bind(userId)
    .first<Row>();
  if (!row) return { ...EMPTY };
  return {
    brandColor: row.brand_color,
    accentColor: row.accent_color,
    backgroundColor: row.background_color,
    font: row.font,
    hasLogo: row.logo_key != null,
    logoType: row.logo_type,
  };
}

export type BrandingPatch = Partial<{
  brandColor: string | null;
  accentColor: string | null;
  backgroundColor: string | null;
  font: string | null;
}>;

// Validate a settings patch. Each present key must be a valid value or null
// (null clears the field back to the standard look). Returns an error string
// for the first bad field, or null when the patch is clean.
export function validatePatch(patch: BrandingPatch): string | null {
  for (const key of ["brandColor", "accentColor", "backgroundColor"] as const) {
    const v = patch[key];
    if (v !== undefined && v !== null && !COLOR_RE.test(v)) {
      return "colors must look like #a1b2c3";
    }
  }
  const f = patch.font;
  if (f !== undefined && f !== null && !(FONT_KEYS as readonly string[]).includes(f)) {
    return "that font is not in the list";
  }
  return null;
}

// Upsert the user's branding row with only the fields present in the patch.
export async function putBranding(
  db: D1Database, userId: number, patch: BrandingPatch
): Promise<Branding> {
  await db
    .prepare("INSERT OR IGNORE INTO user_branding (user_id) VALUES (?1)")
    .bind(userId)
    .run();
  const sets: string[] = ["updated_at = datetime('now')"];
  const binds: (string | number | null)[] = [];
  const cols: Record<string, string | null | undefined> = {
    brand_color: patch.brandColor,
    accent_color: patch.accentColor,
    background_color: patch.backgroundColor,
    font: patch.font,
  };
  for (const [col, val] of Object.entries(cols)) {
    if (val !== undefined) {
      binds.push(val);
      sets.push(`${col} = ?${binds.length}`);
    }
  }
  binds.push(userId);
  await db
    .prepare(`UPDATE user_branding SET ${sets.join(", ")} WHERE user_id = ?${binds.length}`)
    .bind(...binds)
    .run();
  return getBranding(db, userId);
}

export function logoKeyFor(userId: number): string {
  return `branding/${userId}/logo`;
}

export async function setLogo(
  db: D1Database, userId: number, key: string, contentType: string
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO user_branding (user_id) VALUES (?1)")
    .bind(userId)
    .run();
  await db
    .prepare(
      `UPDATE user_branding SET logo_key = ?1, logo_type = ?2,
         updated_at = datetime('now') WHERE user_id = ?3`
    )
    .bind(key, contentType, userId)
    .run();
}

export async function clearLogo(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE user_branding SET logo_key = NULL, logo_type = NULL,
         updated_at = datetime('now') WHERE user_id = ?1`
    )
    .bind(userId)
    .run();
}

export async function resetBranding(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM user_branding WHERE user_id = ?1").bind(userId).run();
}
