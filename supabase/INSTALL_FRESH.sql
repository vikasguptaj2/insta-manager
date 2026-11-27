-- =============================================================================
-- InstaOps v2.0 — Consolidated Supabase PostgreSQL Schema & Security Setup
-- File: supabase/INSTALL_FRESH.sql
-- Safe to execute multiple times in Supabase SQL Editor.
-- Never touches tables belonging to other schemas or applications.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Extensions & Utility Functions (001_extensions_and_enums.sql)
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.instaops_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.instaops_touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instaops_touch_updated_at() TO service_role;

-- -----------------------------------------------------------------------------
-- 2. Relational Core Tables with Permanent UUIDs (002_core_tables.sql)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.instaops_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key TEXT NOT NULL UNIQUE,
  account_label TEXT NOT NULL,
  ig_user_id TEXT NOT NULL UNIQUE CHECK (ig_user_id ~ '^[0-9]{8,}$'),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.instaops_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id TEXT NOT NULL UNIQUE CHECK (post_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  account_id UUID REFERENCES public.instaops_accounts(id) ON DELETE SET NULL,
  account_key TEXT NOT NULL DEFAULT 'A',
  ig_user_id TEXT NOT NULL DEFAULT '17841453414532595',
  source_instagram_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  source_username TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT 'REEL' CHECK (media_type IN ('REEL', 'IMAGE', 'CAROUSEL')),
  media_url TEXT NOT NULL DEFAULT '',
  original_caption TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  caption_status TEXT NOT NULL DEFAULT 'unknown' CHECK (caption_status IN ('available', 'empty', 'unavailable', 'unknown')),
  caption_source TEXT NOT NULL DEFAULT '',
  hashtags JSONB NOT NULL DEFAULT '[]'::jsonb,
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_count INTEGER NOT NULL DEFAULT 0 CHECK (media_count >= 0),
  image_count INTEGER NOT NULL DEFAULT 0 CHECK (image_count >= 0),
  video_count INTEGER NOT NULL DEFAULT 0 CHECK (video_count >= 0),
  source_published_at TIMESTAMPTZ,
  source_like_count BIGINT,
  source_comment_count BIGINT,
  source_play_count BIGINT,
  source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  file_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (file_size_bytes >= 0),
  publish_mode TEXT NOT NULL DEFAULT 'NOW' CHECK (publish_mode IN ('NOW', 'LATER')),
  publish_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (
    status IN (
      'DRAFT', 'EXTRACTING', 'UPLOADING', 'READY', 'SCHEDULED',
      'PUBLISHING', 'PUBLISHED', 'FAILED', 'VERIFY_MANUALLY',
      'ARCHIVED', 'DELETING', 'MEDIA_DELETED', 'DELETED'
    )
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  approved_revision INTEGER,
  container_id TEXT NOT NULL DEFAULT '',
  child_container_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  published_id TEXT NOT NULL DEFAULT '',
  published_url TEXT NOT NULL DEFAULT '',
  published_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  execution_id TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_stage TEXT NOT NULL DEFAULT '',
  sheets_sync_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    sheets_sync_status IN ('PENDING', 'SYNCING', 'SYNCED', 'FAILED', 'SKIPPED')
  ),
  sheets_synced_at TIMESTAMPTZ,
  sheets_sync_error TEXT NOT NULL DEFAULT '',
  schema_version TEXT NOT NULL DEFAULT '2.0',
  extracted_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.instaops_media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  internal_asset_id TEXT NOT NULL UNIQUE,
  post_uuid UUID NOT NULL REFERENCES public.instaops_posts(id) ON DELETE RESTRICT,
  post_id TEXT NOT NULL,
  media_index INTEGER NOT NULL CHECK (media_index >= 0),
  media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE', 'VIDEO')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('image', 'video')),
  delivery_type TEXT NOT NULL DEFAULT 'upload' CHECK (delivery_type IN ('upload', 'authenticated', 'private')),
  source_expires_at TIMESTAMPTZ,
  cloudinary_public_id TEXT NOT NULL DEFAULT '',
  cloudinary_asset_id TEXT NOT NULL DEFAULT '',
  secure_url TEXT NOT NULL DEFAULT '',
  thumbnail_url TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT '',
  file_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (file_size_bytes >= 0),
  width INTEGER,
  height INTEGER,
  duration NUMERIC,
  ig_child_container_id TEXT NOT NULL DEFAULT '',
  storage_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (
    storage_status IN ('ACTIVE', 'DELETE_PENDING', 'DELETED', 'PARTIAL_DELETE', 'UNMANAGED', 'FAILED')
  ),
  error TEXT NOT NULL DEFAULT '',
  deleted_at TIMESTAMPTZ,
  permanently_deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_uuid, media_index)
);

CREATE TABLE IF NOT EXISTS public.instaops_post_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_uuid UUID NOT NULL REFERENCES public.instaops_posts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  caption TEXT NOT NULL DEFAULT '',
  original_caption TEXT NOT NULL DEFAULT '',
  change_source TEXT NOT NULL DEFAULT 'STUDIO',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_uuid, revision)
);

CREATE TABLE IF NOT EXISTS public.instaops_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id TEXT NOT NULL UNIQUE,
  post_uuid UUID REFERENCES public.instaops_posts(id) ON DELETE SET NULL,
  post_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  execution_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.instaops_job_locks (
  lock_key TEXT PRIMARY KEY,
  post_uuid UUID REFERENCES public.instaops_posts(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS public.instaops_idempotency_keys (
  idem_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED')),
  response_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS public.instaops_execution_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL DEFAULT '',
  execution_id TEXT NOT NULL DEFAULT '',
  workflow_id TEXT NOT NULL DEFAULT '',
  workflow_name TEXT NOT NULL DEFAULT '',
  post_uuid UUID REFERENCES public.instaops_posts(id) ON DELETE SET NULL,
  post_id TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL DEFAULT '',
  trigger_source TEXT NOT NULL DEFAULT 'DASHBOARD',
  stage TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms BIGINT,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  retryable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.instaops_sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('POST', 'MEDIA_ASSET', 'EXECUTION_LOG', 'ACCOUNT')),
  entity_uuid UUID NOT NULL,
  external_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT', 'SOFT_DELETE', 'DELETE_MEDIA', 'ARCHIVE')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.instaops_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_uuid UUID REFERENCES public.instaops_posts(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'operator',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.instaops_accounts (account_key, account_label, ig_user_id, enabled)
VALUES ('A', '@vikas.sphere', '17841453414532595', true)
ON CONFLICT (account_key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Indexes & Triggers (003_indexes_and_constraints.sql)
-- -----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uniq_instaops_posts_active_source_id
  ON public.instaops_posts (source_id)
  WHERE deleted_at IS NULL AND status <> 'DELETED' AND source_id <> '';

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

-- -----------------------------------------------------------------------------
-- 4. Transactional RPC Functions & Locking (004_functions_and_locking.sql)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.instaops_acquire_lock(
  p_lock_key TEXT,
  p_post_uuid UUID,
  p_post_id TEXT,
  p_operation TEXT,
  p_owner_id TEXT,
  p_request_id TEXT,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  acquired BOOLEAN,
  lock_key TEXT,
  post_id TEXT,
  operation TEXT,
  owner_id TEXT,
  request_id TEXT,
  acquired_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease INTEGER := GREATEST(15, LEAST(3600, COALESCE(p_lease_seconds, 300)));
  v_row public.instaops_job_locks%ROWTYPE;
BEGIN
  INSERT INTO public.instaops_job_locks (
    lock_key, post_uuid, post_id, operation, owner_id, request_id, acquired_at, expires_at
  )
  VALUES (
    p_lock_key, p_post_uuid, p_post_id, p_operation, p_owner_id, p_request_id, NOW(),
    NOW() + (v_lease::TEXT || ' seconds')::INTERVAL
  )
  ON CONFLICT ON CONSTRAINT instaops_job_locks_pkey DO UPDATE
    SET post_uuid = EXCLUDED.post_uuid,
        post_id = EXCLUDED.post_id,
        operation = EXCLUDED.operation,
        owner_id = EXCLUDED.owner_id,
        request_id = EXCLUDED.request_id,
        acquired_at = NOW(),
        expires_at = EXCLUDED.expires_at
    WHERE public.instaops_job_locks.expires_at < NOW()
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at;
  ELSE
    SELECT * INTO v_row FROM public.instaops_job_locks AS jl WHERE jl.lock_key = p_lock_key;
    RETURN QUERY SELECT false, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_release_lock(
  p_lock_key TEXT,
  p_owner_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.instaops_job_locks
   WHERE lock_key = p_lock_key AND owner_id = p_owner_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_release_stale_locks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.instaops_job_locks WHERE expires_at < NOW();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_claim_idempotency(
  p_idem_key TEXT,
  p_request_hash TEXT,
  p_ttl_seconds INTEGER DEFAULT 86400
)
RETURNS TABLE (
  claimed BOOLEAN,
  existing_state TEXT,
  existing_response JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ttl INTEGER := GREATEST(60, LEAST(604800, COALESCE(p_ttl_seconds, 86400)));
  v_existing public.instaops_idempotency_keys%ROWTYPE;
BEGIN
  INSERT INTO public.instaops_idempotency_keys (idem_key, request_hash, state, expires_at)
  VALUES (p_idem_key, p_request_hash, 'IN_PROGRESS', NOW() + (v_ttl::TEXT || ' seconds')::INTERVAL)
  ON CONFLICT ON CONSTRAINT instaops_idempotency_keys_pkey DO UPDATE
    SET request_hash = EXCLUDED.request_hash,
        state = 'IN_PROGRESS',
        response_json = NULL,
        expires_at = EXCLUDED.expires_at
    WHERE public.instaops_idempotency_keys.expires_at < NOW();

  IF FOUND THEN
    RETURN QUERY SELECT true, NULL::TEXT, NULL::JSONB;
  ELSE
    SELECT * INTO v_existing FROM public.instaops_idempotency_keys AS ik WHERE ik.idem_key = p_idem_key;
    RETURN QUERY SELECT false, v_existing.state, v_existing.response_json;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_complete_idempotency(
  p_idem_key TEXT,
  p_state TEXT,
  p_response JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.instaops_idempotency_keys
     SET state = p_state,
         response_json = p_response
   WHERE idem_key = p_idem_key;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_soft_delete_post(
  p_post_uuid UUID,
  p_reason TEXT DEFAULT ''
)
RETURNS public.instaops_posts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post public.instaops_posts%ROWTYPE;
BEGIN
  SELECT * INTO v_post FROM public.instaops_posts WHERE id = p_post_uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post % not found', p_post_uuid;
  END IF;
  IF v_post.status = 'PUBLISHED' OR v_post.published_id <> '' THEN
    RAISE EXCEPTION 'Published post cannot be deleted; archive instead';
  END IF;

  UPDATE public.instaops_posts
     SET status = 'DELETED',
         deleted_at = NOW(),
         approved_revision = NULL,
         sheets_sync_status = 'PENDING',
         error = CASE WHEN COALESCE(p_reason, '') <> '' THEN 'Soft-deleted: ' || p_reason ELSE error END
   WHERE id = p_post_uuid
   RETURNING * INTO v_post;

  INSERT INTO public.instaops_sync_queue (entity_type, entity_uuid, external_id, operation, payload, idempotency_key)
  VALUES (
    'POST',
    v_post.id,
    v_post.post_id,
    'SOFT_DELETE',
    jsonb_build_object('post_uuid', v_post.id, 'post_id', v_post.post_id, 'status', v_post.status, 'deleted_at', v_post.deleted_at, 'reason', COALESCE(p_reason, '')),
    'soft_del:' || v_post.id::TEXT || ':' || EXTRACT(EPOCH FROM NOW())::BIGINT::TEXT
  )
  ON CONFLICT ON CONSTRAINT instaops_sync_queue_idempotency_key_key DO NOTHING;

  INSERT INTO public.instaops_audit_events (post_uuid, entity_type, entity_id, action, details)
  VALUES (v_post.id, 'POST', v_post.post_id, 'SOFT_DELETE', jsonb_build_object('reason', COALESCE(p_reason, '')));

  RETURN v_post;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_claim_sync_batch(
  p_worker_id TEXT,
  p_batch_size INTEGER DEFAULT 10
)
RETURNS SETOF public.instaops_sync_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT sq.id
      FROM public.instaops_sync_queue AS sq
     WHERE sq.status IN ('PENDING', 'FAILED')
       AND sq.attempts < sq.max_attempts
       AND sq.next_retry_at <= NOW()
     ORDER BY sq.created_at ASC
     LIMIT GREATEST(1, LEAST(50, COALESCE(p_batch_size, 10)))
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.instaops_sync_queue AS sq
     SET status = 'PROCESSING',
         locked_by = p_worker_id,
         locked_at = NOW(),
         attempts = sq.attempts + 1
    FROM picked
   WHERE sq.id = picked.id
   RETURNING sq.*;
END;
$$;

REVOKE ALL ON FUNCTION public.instaops_acquire_lock(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_release_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_release_stale_locks() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_claim_idempotency(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_complete_idempotency(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_soft_delete_post(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_claim_sync_batch(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.instaops_acquire_lock(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_release_lock(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_release_stale_locks() TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_claim_idempotency(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_complete_idempotency(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_soft_delete_post(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_claim_sync_batch(TEXT, INTEGER) TO service_role;

-- -----------------------------------------------------------------------------
-- 5. Row-Level Security & Least-Privilege Grants (005_rls_and_security.sql)
-- -----------------------------------------------------------------------------
ALTER TABLE public.instaops_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_post_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_job_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instaops_audit_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.instaops_accounts FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_posts FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_media_assets FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_post_revisions FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_jobs FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_job_locks FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_idempotency_keys FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_execution_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_sync_queue FROM anon, authenticated;
REVOKE ALL ON TABLE public.instaops_audit_events FROM anon, authenticated;

GRANT ALL ON TABLE public.instaops_accounts TO service_role;
GRANT ALL ON TABLE public.instaops_posts TO service_role;
GRANT ALL ON TABLE public.instaops_media_assets TO service_role;
GRANT ALL ON TABLE public.instaops_post_revisions TO service_role;
GRANT ALL ON TABLE public.instaops_jobs TO service_role;
GRANT ALL ON TABLE public.instaops_job_locks TO service_role;
GRANT ALL ON TABLE public.instaops_idempotency_keys TO service_role;
GRANT ALL ON TABLE public.instaops_execution_logs TO service_role;
GRANT ALL ON TABLE public.instaops_sync_queue TO service_role;
GRANT ALL ON TABLE public.instaops_audit_events TO service_role;

DROP POLICY IF EXISTS "deny_client_accounts" ON public.instaops_accounts;
CREATE POLICY "deny_client_accounts" ON public.instaops_accounts AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_accounts" ON public.instaops_accounts;
CREATE POLICY "service_accounts" ON public.instaops_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_posts" ON public.instaops_posts;
CREATE POLICY "deny_client_posts" ON public.instaops_posts AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_posts" ON public.instaops_posts;
CREATE POLICY "service_posts" ON public.instaops_posts FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_media_assets" ON public.instaops_media_assets;
CREATE POLICY "deny_client_media_assets" ON public.instaops_media_assets AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_media_assets" ON public.instaops_media_assets;
CREATE POLICY "service_media_assets" ON public.instaops_media_assets FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_post_revisions" ON public.instaops_post_revisions;
CREATE POLICY "deny_client_post_revisions" ON public.instaops_post_revisions AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_post_revisions" ON public.instaops_post_revisions;
CREATE POLICY "service_post_revisions" ON public.instaops_post_revisions FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_jobs" ON public.instaops_jobs;
CREATE POLICY "deny_client_jobs" ON public.instaops_jobs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_jobs" ON public.instaops_jobs;
CREATE POLICY "service_jobs" ON public.instaops_jobs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_job_locks" ON public.instaops_job_locks;
CREATE POLICY "deny_client_job_locks" ON public.instaops_job_locks AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_job_locks" ON public.instaops_job_locks;
CREATE POLICY "service_job_locks" ON public.instaops_job_locks FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_idempotency_keys" ON public.instaops_idempotency_keys;
CREATE POLICY "deny_client_idempotency_keys" ON public.instaops_idempotency_keys AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_idempotency_keys" ON public.instaops_idempotency_keys;
CREATE POLICY "service_idempotency_keys" ON public.instaops_idempotency_keys FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_execution_logs" ON public.instaops_execution_logs;
CREATE POLICY "deny_client_execution_logs" ON public.instaops_execution_logs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_execution_logs" ON public.instaops_execution_logs;
CREATE POLICY "service_execution_logs" ON public.instaops_execution_logs FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_sync_queue" ON public.instaops_sync_queue;
CREATE POLICY "deny_client_sync_queue" ON public.instaops_sync_queue AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_sync_queue" ON public.instaops_sync_queue;
CREATE POLICY "service_sync_queue" ON public.instaops_sync_queue FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_client_audit_events" ON public.instaops_audit_events;
CREATE POLICY "deny_client_audit_events" ON public.instaops_audit_events AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_audit_events" ON public.instaops_audit_events;
CREATE POLICY "service_audit_events" ON public.instaops_audit_events FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
