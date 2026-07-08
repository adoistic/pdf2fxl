// Job state machine. Every transition is a conditional UPDATE guarded by the
// expected current status, so concurrent workers cannot double-drive a job.

export type JobMode = "reflow" | "fixed";
export type JobStatus =
  | "received" | "preparing" | "awaiting_ocr" | "processing"
  | "assembling" | "ready" | "failed";

export interface Job {
  id: string;
  userId: number;
  bulkId: string | null;
  mode: JobMode;
  express: boolean;
  enrich: boolean;
  status: JobStatus;
  title: string | null;
  pageCount: number | null;
  rateMcr: number | null;
  enrichRateMcr: number | null;
  holdId: number | null;
  r2UploadKey: string | null;
  errorPublic: string | null;
  createdAt: string;
}

type JobRow = {
  id: string; user_id: number; bulk_id: string | null; mode: JobMode; express: number; enrich: number; status: JobStatus;
  title: string | null; page_count: number | null; rate_mcr: number | null; enrich_rate_mcr: number | null;
  hold_id: number | null; r2_upload_key: string | null; error_public: string | null;
  created_at: string;
};

const COLS =
  "id, user_id, bulk_id, mode, express, enrich, status, title, page_count, rate_mcr, enrich_rate_mcr, hold_id, r2_upload_key, error_public, created_at";

function toJob(r: JobRow): Job {
  return {
    id: r.id, userId: r.user_id, bulkId: r.bulk_id, mode: r.mode, express: r.express === 1,
    enrich: r.enrich === 1, status: r.status, title: r.title, pageCount: r.page_count,
    rateMcr: r.rate_mcr, enrichRateMcr: r.enrich_rate_mcr,
    holdId: r.hold_id, r2UploadKey: r.r2_upload_key, errorPublic: r.error_public,
    createdAt: r.created_at,
  };
}

export async function createJob(
  db: D1Database,
  opts: { id?: string; userId: number; bulkId?: string | null; mode: JobMode; express: boolean; enrich?: boolean; title: string | null; r2UploadKey: string }
): Promise<Job> {
  const id = opts.id ?? crypto.randomUUID();
  const row = await db
    .prepare(
      `INSERT INTO jobs (id, user_id, bulk_id, mode, express, enrich, title, r2_upload_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING ${COLS}`
    )
    .bind(id, opts.userId, opts.bulkId ?? null, opts.mode, opts.express ? 1 : 0, opts.enrich ? 1 : 0, opts.title, opts.r2UploadKey)
    .first<JobRow>();
  return toJob(row!);
}

export async function getJobForUser(db: D1Database, id: string, userId: number): Promise<Job | null> {
  const row = await db
    .prepare(`SELECT ${COLS} FROM jobs WHERE id = ?1 AND user_id = ?2`)
    .bind(id, userId)
    .first<JobRow>();
  return row ? toJob(row) : null;
}

export interface JobPage {
  jobs: Job[];
  total: number;
}

export interface ListOpts {
  limit?: number;
  offset?: number;
  q?: string;
}

// Escape LIKE wildcards in user input so a search for "50%" matches literally.
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Paged, searchable list. An account can hold thousands of editions, so the
// full list never crosses the wire: newest first, bounded page, total for the
// "N of M" label and the show-more button.
export async function listJobsForUser(
  db: D1Database,
  userId: number,
  opts: ListOpts = {}
): Promise<JobPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 200);
  const offset = Math.max(0, opts.offset ?? 0);
  const q = (opts.q ?? "").trim();
  const where = q
    ? "user_id = ?1 AND title LIKE ?2 ESCAPE '\\'"
    : "user_id = ?1";
  const binds: (string | number)[] = q ? [userId, likePattern(q)] : [userId];
  const [{ results }, count] = await Promise.all([
    db
      .prepare(
        `SELECT ${COLS} FROM jobs WHERE ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
      )
      .bind(...binds, limit, offset)
      .all<JobRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
  ]);
  return { jobs: results.map(toJob), total: count?.n ?? 0 };
}

// Extra columns settable on transition. Keys are whitelisted, never caller input.
const TRANSITION_COLS = ["page_count", "rate_mcr", "enrich_rate_mcr", "hold_id", "batch_id", "engine_version"] as const;
type TransitionExtra = Partial<Record<(typeof TRANSITION_COLS)[number], string | number>>;

export async function transition(
  db: D1Database,
  id: string,
  from: JobStatus,
  to: JobStatus,
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
    .prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?${binds.length - 1} AND status = ?${binds.length}`)
    .bind(...binds)
    .run();
  return res.meta.changes === 1;
}

export async function failJob(
  db: D1Database,
  id: string,
  from: JobStatus,
  errorPublic: string,
  errorInternal: string
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE jobs SET status = 'failed', error_public = ?1, error_internal = ?2,
       updated_at = datetime('now') WHERE id = ?3 AND status = ?4`
    )
    .bind(errorPublic, errorInternal, id, from)
    .run();
  return res.meta.changes === 1;
}
