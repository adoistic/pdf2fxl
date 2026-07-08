import type { Env } from "./types";
import { captureHold, releaseHold } from "./ledger";

// Housekeeping that keeps the system honest over time. Two entry points:
//
//   cleanupUpload  precise deletion of one job's original PDF, driven by a
//                  delayed queue message ~10 minutes after the edition is
//                  ready. The original costs storage and serves nothing once
//                  results exist.
//   sweep          the hourly cron safety net: fails work that got stuck,
//                  settles holds that a crash left dangling, and deletes any
//                  upload the precise path missed. Every action here is also
//                  guarded by the ledger's settle-once index, so the sweep
//                  can never double-settle against live traffic.
//
// The 72h R2 lifecycle rule on uploads/ stays as the final backstop for PDFs
// that never reach 'ready' (waiting for credits, failed, abandoned).

// Delete the original PDF of one delivered job. A no-op unless the job is
// 'ready' (failed/waiting uploads keep their 72h backstop window).
export async function cleanupUpload(env: Env, jobId: string): Promise<boolean> {
  const row = await env.DB
    .prepare("SELECT status, r2_upload_key FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<{ status: string; r2_upload_key: string | null }>();
  if (!row || row.status !== "ready" || !row.r2_upload_key) return false;
  await env.STORE.delete(row.r2_upload_key);
  await env.DB
    .prepare("UPDATE jobs SET r2_upload_key = NULL, updated_at = datetime('now') WHERE id = ?1 AND status = 'ready'")
    .bind(jobId)
    .run();
  return true;
}

const STUCK_MESSAGE =
  "something went wrong while reading this document, your credits were not charged";
const SWEEP_BATCH = 50;

export interface SweepReport {
  stuckJobs: number;
  stuckTranslations: number;
  capturedHolds: number;
  releasedHolds: number;
  uploadsDeleted: number;
}

export async function sweep(env: Env): Promise<SweepReport> {
  const db = env.DB;
  const report: SweepReport = {
    stuckJobs: 0, stuckTranslations: 0,
    capturedHolds: 0, releasedHolds: 0, uploadsDeleted: 0,
  };

  // 1. Work stuck in flight far past any plausible runtime: fail it and give
  //    the credits back. 'preparing' means /start crashed mid-request (>1h);
  //    'processing' means the queue lost it or retries ran dry (>6h).
  const stuckJobs = await db
    .prepare(
      `SELECT id, hold_id FROM jobs
       WHERE (status = 'preparing' AND updated_at < datetime('now','-1 hour'))
          OR (status = 'processing' AND updated_at < datetime('now','-6 hours'))
       LIMIT ${SWEEP_BATCH}`
    )
    .all<{ id: string; hold_id: number | null }>();
  for (const row of stuckJobs.results) {
    const res = await db
      .prepare(
        `UPDATE jobs SET status = 'failed', error_public = ?1,
           error_internal = 'sweep: stuck in flight', updated_at = datetime('now')
         WHERE id = ?2 AND status IN ('preparing','processing')`
      )
      .bind(STUCK_MESSAGE, row.id)
      .run();
    if (res.meta.changes !== 1) continue; // finalize won the race; leave it be
    report.stuckJobs += 1;
    if (row.hold_id != null && (await releaseHold(db, row.hold_id))) {
      report.releasedHolds += 1;
    }
  }

  const stuckTranslations = await db
    .prepare(
      `SELECT id, hold_id FROM translations
       WHERE status = 'processing' AND updated_at < datetime('now','-2 hours')
       LIMIT ${SWEEP_BATCH}`
    )
    .all<{ id: string; hold_id: number | null }>();
  for (const row of stuckTranslations.results) {
    const res = await db
      .prepare(
        `UPDATE translations SET status = 'failed',
           error_public = 'something went wrong while translating, your credits were not charged',
           error_internal = 'sweep: stuck in flight', updated_at = datetime('now')
         WHERE id = ?1 AND status = 'processing'`
      )
      .bind(row.id)
      .run();
    if (res.meta.changes !== 1) continue;
    report.stuckTranslations += 1;
    if (row.hold_id != null && (await releaseHold(db, row.hold_id))) {
      report.releasedHolds += 1;
    }
  }

  // 2. Delivered work whose hold was never settled (a crash between writing
  //    artifacts and capturing): the work WAS delivered, so capture.
  for (const table of ["jobs", "translations"] as const) {
    const rows = await db
      .prepare(
        `SELECT hold_id FROM ${table}
         WHERE status = 'ready' AND hold_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM credit_ledger s
                           WHERE s.ref_id = ${table}.hold_id
                             AND s.kind IN ('capture','release'))
         LIMIT ${SWEEP_BATCH}`
      )
      .all<{ hold_id: number }>();
    for (const row of rows.results) {
      if (await captureHold(db, row.hold_id)) report.capturedHolds += 1;
    }
  }

  // 3. Orphan holds: unsettled, old enough to be clear of live traffic, and
  //    no non-failed row claims them (covers failed rows whose release
  //    crashed, and holds whose transition never recorded a hold_id).
  const orphans = await db
    .prepare(
      `SELECT id FROM credit_ledger h
       WHERE h.kind = 'hold'
         AND h.created_at < datetime('now','-2 hours')
         AND NOT EXISTS (SELECT 1 FROM credit_ledger s
                         WHERE s.ref_id = h.id AND s.kind IN ('capture','release'))
         AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.hold_id = h.id AND j.status != 'failed')
         AND NOT EXISTS (SELECT 1 FROM translations t
                         WHERE t.hold_id = h.id AND t.status != 'failed')
       LIMIT ${SWEEP_BATCH}`
    )
    .all<{ id: number }>();
  for (const row of orphans.results) {
    if (await releaseHold(db, row.id)) report.releasedHolds += 1;
  }

  // 4. Originals the precise cleanup missed: any ready job still holding its
  //    PDF ten minutes after finishing.
  const uploads = await db
    .prepare(
      `SELECT id, r2_upload_key FROM jobs
       WHERE status = 'ready' AND r2_upload_key IS NOT NULL
         AND finished_at IS NOT NULL
         AND finished_at < datetime('now','-10 minutes')
       LIMIT ${SWEEP_BATCH}`
    )
    .all<{ id: string; r2_upload_key: string }>();
  for (const row of uploads.results) {
    await env.STORE.delete(row.r2_upload_key);
    await db
      .prepare("UPDATE jobs SET r2_upload_key = NULL, updated_at = datetime('now') WHERE id = ?1")
      .bind(row.id)
      .run();
    report.uploadsDeleted += 1;
  }

  return report;
}
