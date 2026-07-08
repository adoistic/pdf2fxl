// Translation state machine. Same discipline as jobs.ts: every transition is
// a conditional UPDATE guarded by the expected current status, so concurrent
// workers cannot double-drive a translation.

export type TranslationKind = "text" | "book";
export type TranslationStatus = "received" | "processing" | "ready" | "failed";

export interface Translation {
  id: string;
  userId: number;
  kind: TranslationKind;
  jobId: string | null;
  targetLanguage: string;
  status: TranslationStatus;
  title: string | null;
  wordCount: number | null;
  blockWords: number | null;
  blockMcr: number | null;
  chargedMcr: number | null;
  holdId: number | null;
  r2SourceKey: string | null;
  r2MdKey: string | null;
  r2DocKey: string | null;
  errorPublic: string | null;
  createdAt: string;
}

type Row = {
  id: string; user_id: number; kind: TranslationKind; job_id: string | null;
  target_language: string; status: TranslationStatus; title: string | null;
  word_count: number | null; block_words: number | null; block_mcr: number | null;
  charged_mcr: number | null; hold_id: number | null; r2_source_key: string | null;
  r2_md_key: string | null; r2_doc_key: string | null; error_public: string | null;
  created_at: string;
};

const COLS =
  "id, user_id, kind, job_id, target_language, status, title, word_count, " +
  "block_words, block_mcr, charged_mcr, hold_id, r2_source_key, r2_md_key, " +
  "r2_doc_key, error_public, created_at";

function toTranslation(r: Row): Translation {
  return {
    id: r.id, userId: r.user_id, kind: r.kind, jobId: r.job_id,
    targetLanguage: r.target_language, status: r.status, title: r.title,
    wordCount: r.word_count, blockWords: r.block_words, blockMcr: r.block_mcr,
    chargedMcr: r.charged_mcr, holdId: r.hold_id, r2SourceKey: r.r2_source_key,
    r2MdKey: r.r2_md_key, r2DocKey: r.r2_doc_key, errorPublic: r.error_public,
    createdAt: r.created_at,
  };
}

export async function createTranslation(
  db: D1Database,
  opts: {
    id: string; userId: number; kind: TranslationKind; jobId?: string | null;
    targetLanguage: string; title: string | null; wordCount: number;
    blockWords: number; blockMcr: number; chargedMcr: number;
    r2SourceKey: string;
  }
): Promise<Translation> {
  const row = await db
    .prepare(
      `INSERT INTO translations (id, user_id, kind, job_id, target_language,
         title, word_count, block_words, block_mcr, charged_mcr, r2_source_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING ${COLS}`
    )
    .bind(
      opts.id, opts.userId, opts.kind, opts.jobId ?? null, opts.targetLanguage,
      opts.title, opts.wordCount, opts.blockWords, opts.blockMcr,
      opts.chargedMcr, opts.r2SourceKey
    )
    .first<Row>();
  return toTranslation(row!);
}

export async function getTranslationForUser(
  db: D1Database, id: string, userId: number
): Promise<Translation | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM translations WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<Row>();
  return row ? toTranslation(row) : null;
}

export async function getTranslation(db: D1Database, id: string): Promise<Translation | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM translations WHERE id = ?1`)
    .bind(id)
    .first<Row>();
  return row ? toTranslation(row) : null;
}

export interface TranslationPage {
  translations: Translation[];
  total: number;
}

// Paged like the jobs list: newest first, bounded window, total for the label.
export async function listTranslationsForUser(
  db: D1Database,
  userId: number,
  opts: { limit?: number; offset?: number } = {}
): Promise<TranslationPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const [{ results }, count] = await Promise.all([
    db
      .prepare(
        `SELECT ${COLS} FROM translations WHERE user_id = ?1
         ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3`
      )
      .bind(userId, limit, offset)
      .all<Row>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM translations WHERE user_id = ?1")
      .bind(userId)
      .first<{ n: number }>(),
  ]);
  return { translations: results.map(toTranslation), total: count?.n ?? 0 };
}

// Extra columns settable on transition. Keys are whitelisted, never caller
// input. The finalize path writes r2 keys and finished_at directly (guarded on
// 'processing'), mirroring finalizeJob.
const TRANSITION_COLS = ["hold_id"] as const;
type TransitionExtra = Partial<Record<(typeof TRANSITION_COLS)[number], string | number>>;

export async function transitionTranslation(
  db: D1Database,
  id: string,
  from: TranslationStatus,
  to: TranslationStatus,
  extra: TransitionExtra = {}
): Promise<boolean> {
  const sets = ["status = ?1", "updated_at = datetime('now')"];
  const binds: (string | number)[] = [to];
  for (const col of TRANSITION_COLS) {
    const val = extra[col];
    if (val !== undefined) {
      binds.push(val);
      sets.push(`${col} = ?${binds.length}`);
    }
  }
  binds.push(id, from);
  const res = await db
    .prepare(
      `UPDATE translations SET ${sets.join(", ")}
       WHERE id = ?${binds.length - 1} AND status = ?${binds.length}`
    )
    .bind(...binds)
    .run();
  return res.meta.changes === 1;
}

export async function failTranslation(
  db: D1Database,
  id: string,
  from: TranslationStatus,
  errorPublic: string,
  errorInternal: string
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE translations SET status = 'failed', error_public = ?1,
         error_internal = ?2, updated_at = datetime('now')
       WHERE id = ?3 AND status = ?4`
    )
    .bind(errorPublic, errorInternal, id, from)
    .run();
  return res.meta.changes === 1;
}
