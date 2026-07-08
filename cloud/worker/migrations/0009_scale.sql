-- Thousands of editions per account: lists are paged and searched server-side,
-- ordered by (created_at, id) descending. These composite indexes serve that
-- exact ordering per user.
CREATE INDEX ix_jobs_user_created ON jobs(user_id, created_at DESC, id DESC);
CREATE INDEX ix_translations_user_created ON translations(user_id, created_at DESC, id DESC);
