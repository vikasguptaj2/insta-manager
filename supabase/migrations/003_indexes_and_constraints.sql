-- 003_indexes_and_constraints.sql
-- Indexes on foreign keys, uniqueness guards, hot operational queries, and updated_at triggers.

-- Active non-deleted Instagram shortcode uniqueness (prevents duplicate active records atomically)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_instaops_posts_active_source_id
  ON public.instaops_posts (source_id)
  WHERE deleted_at IS NULL AND status <> 'DELETED' AND source_id <> '';

-- Fast operational dashboard filters & foreign keys
CREATE INDEX IF NOT EXISTS idx_instaops_posts_account_id
  ON public.instaops_posts (account_id);

CREATE INDEX IF NOT EXISTS idx_instaops_posts_status_updated
  ON public.instaops_posts (status, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instaops_posts_due_schedule
  ON public.instaops_posts (publish_at ASC)
  WHERE status = 'SCHEDULED' AND publish_mode = 'LATER' AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instaops_posts_sync_pending
  ON public.instaops_posts (sheets_sync_status, updated_at ASC)
  WHERE sheets_sync_status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_instaops_media_assets_post_uuid
  ON public.instaops_media_assets (post_uuid, media_index ASC);

CREATE INDEX IF NOT EXISTS idx_instaops_media_assets_status
  ON public.instaops_media_assets (storage_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_instaops_jobs_post_created
  ON public.instaops_jobs (post_uuid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instaops_jobs_active
  ON public.instaops_jobs (status, updated_at DESC)
  WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_instaops_locks_expires
  ON public.instaops_job_locks (expires_at);

CREATE INDEX IF NOT EXISTS idx_instaops_idem_expires
  ON public.instaops_idempotency_keys (expires_at);

CREATE INDEX IF NOT EXISTS idx_instaops_logs_post_created
  ON public.instaops_execution_logs (post_uuid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instaops_sync_queue_claimable
  ON public.instaops_sync_queue (status, next_retry_at ASC)
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS idx_instaops_sync_queue_processing_stale
  ON public.instaops_sync_queue (locked_at ASC)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_instaops_sync_queue_entity_rev
  ON public.instaops_sync_queue (entity_uuid, source_revision DESC)
  WHERE entity_type = 'POST';

CREATE INDEX IF NOT EXISTS idx_instaops_jobs_unresolved_publish
  ON public.instaops_jobs (post_uuid, created_at DESC)
  WHERE operation = 'PUBLISH' AND status IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN');

-- Automatic updated_at triggers
DROP TRIGGER IF EXISTS trg_instaops_accounts_updated_at ON public.instaops_accounts;
CREATE TRIGGER trg_instaops_accounts_updated_at
  BEFORE UPDATE ON public.instaops_accounts
  FOR EACH ROW EXECUTE FUNCTION public.instaops_touch_updated_at();

DROP TRIGGER IF EXISTS trg_instaops_posts_updated_at ON public.instaops_posts;
CREATE TRIGGER trg_instaops_posts_updated_at
  BEFORE UPDATE ON public.instaops_posts
  FOR EACH ROW EXECUTE FUNCTION public.instaops_touch_updated_at();

DROP TRIGGER IF EXISTS trg_instaops_media_assets_updated_at ON public.instaops_media_assets;
CREATE TRIGGER trg_instaops_media_assets_updated_at
  BEFORE UPDATE ON public.instaops_media_assets
  FOR EACH ROW EXECUTE FUNCTION public.instaops_touch_updated_at();

DROP TRIGGER IF EXISTS trg_instaops_jobs_updated_at ON public.instaops_jobs;
CREATE TRIGGER trg_instaops_jobs_updated_at
  BEFORE UPDATE ON public.instaops_jobs
  FOR EACH ROW EXECUTE FUNCTION public.instaops_touch_updated_at();

DROP TRIGGER IF EXISTS trg_instaops_sync_queue_updated_at ON public.instaops_sync_queue;
CREATE TRIGGER trg_instaops_sync_queue_updated_at
  BEFORE UPDATE ON public.instaops_sync_queue
  FOR EACH ROW EXECUTE FUNCTION public.instaops_touch_updated_at();
