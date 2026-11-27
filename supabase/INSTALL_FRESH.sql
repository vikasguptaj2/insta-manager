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
  lock_key TEXT NOT NULL DEFAULT '',
  lock_owner TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
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
  source_revision INTEGER NOT NULL DEFAULT 0,
  payload_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

CREATE TABLE IF NOT EXISTS public.instaops_runtime_settings (
  setting_key TEXT PRIMARY KEY CHECK (setting_key = 'default'),
  live_publish_enabled BOOLEAN NOT NULL DEFAULT false,
  live_delete_enabled BOOLEAN NOT NULL DEFAULT false,
  scheduling_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_by TEXT NOT NULL DEFAULT 'system',
  change_reason TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.instaops_runtime_settings (
  setting_key, live_publish_enabled, live_delete_enabled, scheduling_enabled, updated_by, change_reason
) VALUES (
  'default', false, false, false, 'install_fresh', 'Default fail-closed safety gates'
)
ON CONFLICT (setting_key) DO NOTHING;

ALTER TABLE public.instaops_posts
  ADD COLUMN IF NOT EXISTS child_container_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.instaops_media_assets
  ADD COLUMN IF NOT EXISTS ig_child_container_id TEXT NOT NULL DEFAULT '';

ALTER TABLE public.instaops_jobs
  ADD COLUMN IF NOT EXISTS lock_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lock_owner TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.instaops_sync_queue
  ADD COLUMN IF NOT EXISTS source_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payload_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW();

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

CREATE INDEX IF NOT EXISTS idx_instaops_sync_queue_processing_stale
  ON public.instaops_sync_queue (locked_at ASC)
  WHERE status = 'PROCESSING';

CREATE INDEX IF NOT EXISTS idx_instaops_sync_queue_entity_rev
  ON public.instaops_sync_queue (entity_uuid, source_revision DESC)
  WHERE entity_type = 'POST';

CREATE INDEX IF NOT EXISTS idx_instaops_jobs_unresolved_publish
  ON public.instaops_jobs (post_uuid, created_at DESC)
  WHERE operation = 'PUBLISH' AND status IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN');

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

DROP TRIGGER IF EXISTS trg_instaops_runtime_settings_updated_at ON public.instaops_runtime_settings;
CREATE TRIGGER trg_instaops_runtime_settings_updated_at
  BEFORE UPDATE ON public.instaops_runtime_settings
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
  v_post_status TEXT := '';
BEGIN
  IF p_post_uuid IS NOT NULL AND UPPER(COALESCE(p_operation, '')) = 'PUBLISH' THEN
    SELECT p.status INTO v_post_status FROM public.instaops_posts AS p WHERE p.id = p_post_uuid;
    IF v_post_status IN ('VERIFY_MANUALLY', 'PUBLISHED', 'DELETED') THEN
      SELECT * INTO v_row FROM public.instaops_job_locks AS jl WHERE jl.lock_key = p_lock_key;
      RETURN QUERY SELECT false, COALESCE(v_row.lock_key, p_lock_key), COALESCE(v_row.post_id, p_post_id), COALESCE(v_row.operation, p_operation), COALESCE(v_row.owner_id, 'STATUS_LOCKED:' || v_post_status), COALESCE(v_row.request_id, p_request_id), COALESCE(v_row.acquired_at, NOW()), COALESCE(v_row.expires_at, NOW());
      RETURN;
    END IF;
  END IF;

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
      AND NOT (
        public.instaops_job_locks.operation = 'PUBLISH'
        AND UPPER(COALESCE(p_operation, '')) = 'PUBLISH'
        AND p_post_uuid IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.instaops_posts AS p
           WHERE p.id = p_post_uuid AND p.status IN ('PUBLISHING', 'VERIFY_MANUALLY')
        )
      )
  RETURNING * INTO v_row;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at;
  ELSE
    SELECT * INTO v_row FROM public.instaops_job_locks AS jl WHERE jl.lock_key = p_lock_key;
    RETURN QUERY SELECT false, COALESCE(v_row.lock_key, p_lock_key), COALESCE(v_row.post_id, p_post_id), COALESCE(v_row.operation, p_operation), COALESCE(v_row.owner_id, ''), COALESCE(v_row.request_id, ''), COALESCE(v_row.acquired_at, NOW()), COALESCE(v_row.expires_at, NOW());
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_transfer_or_claim_lock(
  p_lock_key TEXT,
  p_post_uuid UUID,
  p_post_id TEXT,
  p_operation TEXT,
  p_expected_owner TEXT,
  p_new_owner TEXT,
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
  expires_at TIMESTAMPTZ,
  reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease INTEGER := GREATEST(15, LEAST(3600, COALESCE(p_lease_seconds, 300)));
  v_row public.instaops_job_locks%ROWTYPE;
  v_post public.instaops_posts%ROWTYPE;
  v_exp TIMESTAMPTZ := NOW() + (v_lease::TEXT || ' seconds')::INTERVAL;
BEGIN
  IF COALESCE(TRIM(p_lock_key), '') = '' OR COALESCE(TRIM(p_new_owner), '') = '' THEN
    RETURN QUERY SELECT false, p_lock_key, p_post_id, p_operation, ''::TEXT, p_request_id, NOW(), NOW(), 'lock_key and new_owner are required'::TEXT;
    RETURN;
  END IF;

  IF p_post_uuid IS NOT NULL AND UPPER(COALESCE(p_operation, '')) = 'PUBLISH' THEN
    SELECT * INTO v_post FROM public.instaops_posts AS p WHERE p.id = p_post_uuid;
    IF FOUND AND (v_post.status IN ('PUBLISHED', 'VERIFY_MANUALLY', 'DELETED', 'ARCHIVED') OR COALESCE(v_post.published_id, '') <> '' OR v_post.deleted_at IS NOT NULL) THEN
      RETURN QUERY SELECT false, p_lock_key, p_post_id, p_operation, ''::TEXT, p_request_id, NOW(), NOW(), ('Post status blocks publish lock: ' || v_post.status)::TEXT;
      RETURN;
    END IF;
  END IF;

  SELECT * INTO v_row FROM public.instaops_job_locks AS jl WHERE jl.lock_key = p_lock_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.instaops_job_locks (lock_key, post_uuid, post_id, operation, owner_id, request_id, acquired_at, expires_at)
    VALUES (p_lock_key, p_post_uuid, p_post_id, p_operation, p_new_owner, p_request_id, NOW(), v_exp)
    RETURNING * INTO v_row;
    RETURN QUERY SELECT true, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at, 'claimed'::TEXT;
    RETURN;
  END IF;

  IF (COALESCE(TRIM(p_expected_owner), '') <> '' AND v_row.owner_id = p_expected_owner) OR v_row.owner_id = p_new_owner THEN
    UPDATE public.instaops_job_locks
       SET post_uuid = COALESCE(p_post_uuid, post_uuid),
           post_id = COALESCE(NULLIF(p_post_id, ''), post_id),
           operation = p_operation,
           owner_id = p_new_owner,
           request_id = COALESCE(NULLIF(p_request_id, ''), request_id),
           expires_at = v_exp
     WHERE public.instaops_job_locks.lock_key = p_lock_key
     RETURNING * INTO v_row;
    RETURN QUERY SELECT true, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at, 'transferred'::TEXT;
    RETURN;
  END IF;

  IF v_row.expires_at < NOW() THEN
    IF v_row.operation = 'PUBLISH' AND UPPER(COALESCE(p_operation, '')) = 'PUBLISH' AND p_post_uuid IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.instaops_posts AS p WHERE p.id = p_post_uuid AND p.status IN ('PUBLISHING', 'VERIFY_MANUALLY')) THEN
      RETURN QUERY SELECT false, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at, 'Expired uncertain PUBLISH lock requires manual reconciliation.'::TEXT;
      RETURN;
    END IF;

    UPDATE public.instaops_job_locks
       SET post_uuid = p_post_uuid,
           post_id = p_post_id,
           operation = p_operation,
           owner_id = p_new_owner,
           request_id = p_request_id,
           acquired_at = NOW(),
           expires_at = v_exp
     WHERE public.instaops_job_locks.lock_key = p_lock_key
     RETURNING * INTO v_row;
    RETURN QUERY SELECT true, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at, 'reclaimed_expired'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, v_row.lock_key, v_row.post_id, v_row.operation, v_row.owner_id, v_row.request_id, v_row.acquired_at, v_row.expires_at, ('Lock held by active owner ' || v_row.owner_id)::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_renew_lock(
  p_lock_key TEXT,
  p_owner_id TEXT,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (
  renewed BOOLEAN,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_lease INTEGER := GREATEST(15, LEAST(3600, COALESCE(p_lease_seconds, 300)));
  v_exp TIMESTAMPTZ;
BEGIN
  UPDATE public.instaops_job_locks
     SET expires_at = NOW() + (v_lease::TEXT || ' seconds')::INTERVAL
   WHERE lock_key = p_lock_key
     AND owner_id = p_owner_id
     AND public.instaops_job_locks.expires_at >= NOW()
   RETURNING public.instaops_job_locks.expires_at INTO v_exp;

  IF FOUND THEN
    RETURN QUERY SELECT true, v_exp;
  ELSE
    RETURN QUERY SELECT false, NULL::TIMESTAMPTZ;
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
  DELETE FROM public.instaops_job_locks AS jl
   WHERE jl.expires_at < NOW()
     AND NOT (
       jl.operation = 'PUBLISH'
       AND jl.post_uuid IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM public.instaops_posts AS p
          WHERE p.id = jl.post_uuid AND p.status IN ('PUBLISHING', 'VERIFY_MANUALLY')
       )
     );
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

CREATE OR REPLACE FUNCTION public.instaops_approve_post_revision(
  p_post_uuid UUID,
  p_reviewed_revision INTEGER
)
RETURNS public.instaops_posts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post public.instaops_posts%ROWTYPE;
BEGIN
  SELECT * INTO v_post FROM public.instaops_posts AS p WHERE p.id = p_post_uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post % not found', p_post_uuid;
  END IF;
  IF v_post.deleted_at IS NOT NULL OR v_post.status IN ('DELETED', 'ARCHIVED', 'PUBLISHED', 'VERIFY_MANUALLY', 'PUBLISHING', 'EXTRACTING', 'UPLOADING', 'DELETING') OR COALESCE(v_post.published_id, '') <> '' THEN
    RAISE EXCEPTION 'Post % in status % cannot be approved for publishing', v_post.post_id, v_post.status;
  END IF;
  IF v_post.revision <> p_reviewed_revision THEN
    RAISE EXCEPTION 'Revision mismatch (expected %, actual %)', p_reviewed_revision, v_post.revision;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.instaops_accounts AS a
     WHERE (a.ig_user_id = v_post.ig_user_id OR a.account_key = v_post.account_key)
       AND a.enabled = true
  ) THEN
    RAISE EXCEPTION 'Destination Instagram account (% / %) is disabled or missing', v_post.account_key, v_post.ig_user_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.instaops_jobs AS j
     WHERE j.post_uuid = p_post_uuid
       AND j.operation = 'PUBLISH'
       AND j.status IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN')
  ) THEN
    RAISE EXCEPTION 'Unresolved previous publication job exists for %', v_post.post_id;
  END IF;

  UPDATE public.instaops_posts
     SET approved_revision = p_reviewed_revision,
         updated_at = NOW()
   WHERE id = p_post_uuid
   RETURNING * INTO v_post;

  INSERT INTO public.instaops_audit_events (post_uuid, entity_type, entity_id, action, details)
  VALUES (v_post.id, 'POST', v_post.post_id, 'APPROVE_REVISION', pg_catalog.jsonb_build_object('approved_revision', p_reviewed_revision));

  RETURN v_post;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_claim_due_scheduled_posts(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 1
)
RETURNS TABLE (
  post_uuid UUID,
  post_id TEXT,
  ig_user_id TEXT,
  media_type TEXT,
  caption TEXT,
  media_url TEXT,
  revision INTEGER,
  approved_revision INTEGER,
  publish_at TIMESTAMPTZ,
  lock_key TEXT,
  lock_owner TEXT,
  job_id TEXT,
  request_id TEXT,
  media_items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_rec public.instaops_posts%ROWTYPE;
  v_lock_key TEXT;
  v_job_id TEXT;
  v_req_id TEXT;
  v_assets JSONB;
BEGIN
  FOR v_rec IN
    SELECT p.*
      FROM public.instaops_posts AS p
     WHERE p.status = 'SCHEDULED'
       AND p.publish_mode = 'LATER'
       AND p.deleted_at IS NULL
       AND p.publish_at <= NOW()
       AND p.approved_revision = p.revision
       AND COALESCE(p.published_id, '') = ''
       AND EXISTS (
         SELECT 1 FROM public.instaops_accounts AS a
          WHERE (a.ig_user_id = p.ig_user_id OR a.account_key = p.account_key)
            AND a.enabled = true
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.instaops_job_locks AS jl
          WHERE jl.lock_key = ('post:' || p.id::TEXT)
            AND jl.expires_at >= NOW()
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.instaops_jobs AS j
          WHERE j.post_uuid = p.id
            AND j.operation = 'PUBLISH'
            AND j.status IN ('QUEUED', 'RUNNING', 'OUTCOME_UNKNOWN')
       )
     ORDER BY p.publish_at ASC
     LIMIT GREATEST(1, LEAST(10, COALESCE(p_limit, 1)))
     FOR UPDATE OF p SKIP LOCKED
  LOOP
    v_lock_key := 'post:' || v_rec.id::TEXT;
    v_job_id := 'job_sched_' || substr(replace(pg_catalog.gen_random_uuid()::TEXT, '-', ''), 1, 12);
    v_req_id := 'sched_' || pg_catalog.gen_random_uuid()::TEXT;

    INSERT INTO public.instaops_job_locks (
      lock_key, post_uuid, post_id, operation, owner_id, request_id, acquired_at, expires_at
    )
    VALUES (
      v_lock_key, v_rec.id, v_rec.post_id, 'PUBLISH', p_worker_id, v_req_id, NOW(), NOW() + INTERVAL '600 seconds'
    )
    ON CONFLICT ON CONSTRAINT instaops_job_locks_pkey DO UPDATE
      SET operation = 'PUBLISH',
          owner_id = EXCLUDED.owner_id,
          request_id = EXCLUDED.request_id,
          acquired_at = NOW(),
          expires_at = EXCLUDED.expires_at
      WHERE public.instaops_job_locks.expires_at < NOW();

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO public.instaops_jobs (
      job_id, post_uuid, post_id, request_id, operation, stage, status, lock_key, lock_owner
    )
    VALUES (
      v_job_id, v_rec.id, v_rec.post_id, v_req_id, 'PUBLISH', 'QUEUED', 'QUEUED', v_lock_key, p_worker_id
    );

    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', ma.id,
          'internal_asset_id', ma.internal_asset_id,
          'media_index', ma.media_index,
          'media_type', ma.media_type,
          'resource_type', ma.resource_type,
          'delivery_type', ma.delivery_type,
          'secure_url', ma.secure_url,
          'cloudinary_public_id', ma.cloudinary_public_id,
          'storage_status', ma.storage_status
        )
        ORDER BY ma.media_index ASC
      ),
      '[]'::jsonb
    )
    INTO v_assets
    FROM public.instaops_media_assets AS ma
    WHERE ma.post_uuid = v_rec.id AND ma.storage_status = 'ACTIVE';

    RETURN QUERY SELECT
      v_rec.id,
      v_rec.post_id,
      v_rec.ig_user_id,
      v_rec.media_type,
      COALESCE(NULLIF(v_rec.caption, ''), v_rec.original_caption),
      v_rec.media_url,
      v_rec.revision,
      v_rec.approved_revision,
      v_rec.publish_at,
      v_lock_key,
      p_worker_id,
      v_job_id,
      v_req_id,
      v_assets;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_finalize_extraction(
  p_post_uuid UUID,
  p_post_patch JSONB,
  p_assets JSONB,
  p_job_id TEXT DEFAULT '',
  p_request_id TEXT DEFAULT '',
  p_execution_id TEXT DEFAULT '',
  p_lock_key TEXT DEFAULT '',
  p_lock_owner TEXT DEFAULT ''
)
RETURNS public.instaops_posts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post public.instaops_posts%ROWTYPE;
  v_status TEXT := CASE WHEN COALESCE(p_post_patch->>'status', 'DRAFT') = 'FAILED' THEN 'FAILED' ELSE 'DRAFT' END;
  v_elem JSONB;
  v_indices INTEGER[] := ARRAY[]::INTEGER[];
  v_asset_row public.instaops_media_assets%ROWTYPE;
  v_new_rev INTEGER;
  v_lock_owner TEXT;
  v_lock_expires TIMESTAMPTZ;
BEGIN
  IF COALESCE(p_lock_key, '') <> '' OR COALESCE(p_lock_owner, '') <> '' THEN
    IF COALESCE(p_lock_key, '') = '' OR COALESCE(p_lock_owner, '') = '' THEN
      RAISE EXCEPTION 'Both p_lock_key and p_lock_owner are required when finalizing extraction with lock verification';
    END IF;
    SELECT jl.owner_id, jl.expires_at
      INTO v_lock_owner, v_lock_expires
      FROM public.instaops_job_locks AS jl
     WHERE jl.lock_key = p_lock_key
     FOR UPDATE;
    IF NOT FOUND OR v_lock_owner <> p_lock_owner OR v_lock_expires < NOW() THEN
      RAISE EXCEPTION 'Cannot finalize extraction: active lock % missing or expired for owner %', p_lock_key, p_lock_owner;
    END IF;
  END IF;

  SELECT * INTO v_post FROM public.instaops_posts AS p WHERE p.id = p_post_uuid AND p.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active post % not found for extraction finalization', p_post_uuid;
  END IF;

  IF v_status = 'DRAFT' THEN
    IF pg_catalog.jsonb_typeof(p_assets) <> 'array' OR pg_catalog.jsonb_array_length(p_assets) < 1 THEN
      RAISE EXCEPTION 'Extraction cannot complete as DRAFT without at least 1 persisted Cloudinary asset';
    END IF;
    FOR v_elem IN SELECT value FROM pg_catalog.jsonb_array_elements(p_assets) LOOP
      IF COALESCE(v_elem->>'cloudinary_public_id', '') = '' OR COALESCE(v_elem->>'secure_url', '') = '' THEN
        RAISE EXCEPTION 'All assets must have verified cloudinary_public_id and secure_url before DRAFT finalization';
      END IF;
    END LOOP;
  END IF;

  IF pg_catalog.jsonb_typeof(p_assets) = 'array' THEN
    FOR v_elem IN SELECT value FROM pg_catalog.jsonb_array_elements(p_assets) LOOP
      v_indices := pg_catalog.array_append(v_indices, COALESCE((v_elem->>'media_index')::INTEGER, 0));
      INSERT INTO public.instaops_media_assets (
        internal_asset_id, post_uuid, post_id, media_index, media_type, resource_type, delivery_type,
        source_expires_at, cloudinary_public_id, cloudinary_asset_id, secure_url, thumbnail_url,
        format, file_size_bytes, width, height, duration, storage_status, error
      )
      VALUES (
        COALESCE(v_elem->>'internal_asset_id', 'ast_' || v_post.post_id || '_' || COALESCE(v_elem->>'media_index', '0')),
        v_post.id,
        v_post.post_id,
        COALESCE((v_elem->>'media_index')::INTEGER, 0),
        COALESCE(v_elem->>'media_type', 'VIDEO'),
        COALESCE(v_elem->>'resource_type', 'video'),
        COALESCE(v_elem->>'delivery_type', 'upload'),
        NULLIF(v_elem->>'source_expires_at', '')::TIMESTAMPTZ,
        COALESCE(v_elem->>'cloudinary_public_id', ''),
        COALESCE(v_elem->>'cloudinary_asset_id', ''),
        COALESCE(v_elem->>'secure_url', ''),
        COALESCE(v_elem->>'thumbnail_url', COALESCE(v_elem->>'secure_url', '')),
        COALESCE(v_elem->>'format', ''),
        GREATEST(0, COALESCE((v_elem->>'file_size_bytes')::BIGINT, 0)),
        CASE WHEN COALESCE(v_elem->>'width', '') ~ '^[0-9]+$' THEN (v_elem->>'width')::INTEGER ELSE NULL END,
        CASE WHEN COALESCE(v_elem->>'height', '') ~ '^[0-9]+$' THEN (v_elem->>'height')::INTEGER ELSE NULL END,
        CASE WHEN COALESCE(v_elem->>'duration', '') ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_elem->>'duration')::NUMERIC ELSE NULL END,
        COALESCE(v_elem->>'storage_status', 'ACTIVE'),
        COALESCE(v_elem->>'error', '')
      )
      ON CONFLICT (post_uuid, media_index) DO UPDATE
        SET internal_asset_id = EXCLUDED.internal_asset_id,
            post_id = EXCLUDED.post_id,
            media_type = EXCLUDED.media_type,
            resource_type = EXCLUDED.resource_type,
            delivery_type = EXCLUDED.delivery_type,
            source_expires_at = EXCLUDED.source_expires_at,
            cloudinary_public_id = EXCLUDED.cloudinary_public_id,
            cloudinary_asset_id = EXCLUDED.cloudinary_asset_id,
            secure_url = EXCLUDED.secure_url,
            thumbnail_url = EXCLUDED.thumbnail_url,
            format = EXCLUDED.format,
            file_size_bytes = EXCLUDED.file_size_bytes,
            width = EXCLUDED.width,
            height = EXCLUDED.height,
            duration = EXCLUDED.duration,
            storage_status = EXCLUDED.storage_status,
            error = EXCLUDED.error,
            deleted_at = CASE WHEN EXCLUDED.storage_status = 'ACTIVE' THEN NULL ELSE public.instaops_media_assets.deleted_at END
      RETURNING * INTO v_asset_row;

      INSERT INTO public.instaops_sync_queue (
        entity_type, entity_uuid, external_id, operation, payload, idempotency_key, source_revision
      )
      VALUES (
        'MEDIA_ASSET',
        v_asset_row.id,
        v_asset_row.internal_asset_id,
        'UPSERT',
        pg_catalog.jsonb_build_object('asset_uuid', v_asset_row.id, 'post_uuid', v_post.id, 'row', pg_catalog.to_jsonb(v_asset_row)),
        'asset:' || v_asset_row.id::TEXT || ':rev' || (v_post.revision + 1)::TEXT,
        v_post.revision + 1
      )
      ON CONFLICT ON CONSTRAINT instaops_sync_queue_idempotency_key_key DO NOTHING;
    END LOOP;
  END IF;

  IF v_status = 'DRAFT' THEN
    UPDATE public.instaops_media_assets
       SET storage_status = 'DELETED',
           deleted_at = NOW()
     WHERE post_uuid = p_post_uuid
       AND storage_status = 'ACTIVE'
       AND NOT (media_index = ANY(v_indices));
  END IF;

  v_new_rev := GREATEST(v_post.revision + 1, COALESCE((p_post_patch->>'revision')::INTEGER, v_post.revision + 1));

  UPDATE public.instaops_posts
     SET media_url = CASE WHEN v_status = 'DRAFT' THEN COALESCE(p_post_patch->>'media_url', media_url) ELSE '' END,
         media_type = COALESCE(p_post_patch->>'media_type', media_type),
         original_caption = COALESCE(p_post_patch->>'original_caption', original_caption),
         caption = COALESCE(p_post_patch->>'caption', caption),
         status = v_status,
         canonical_url = COALESCE(p_post_patch->>'canonical_url', canonical_url),
         source_id = COALESCE(NULLIF(p_post_patch->>'source_id', ''), source_id),
         source_username = COALESCE(p_post_patch->>'source_username', source_username),
         source_kind = COALESCE(p_post_patch->>'source_kind', source_kind),
         caption_status = COALESCE(p_post_patch->>'caption_status', caption_status),
         caption_source = COALESCE(p_post_patch->>'caption_source', caption_source),
         hashtags = COALESCE(p_post_patch->'hashtags', hashtags),
         mentions = COALESCE(p_post_patch->'mentions', mentions),
         media_count = CASE WHEN v_status = 'DRAFT' THEN COALESCE((p_post_patch->>'media_count')::INTEGER, 0) ELSE 0 END,
         image_count = CASE WHEN v_status = 'DRAFT' THEN COALESCE((p_post_patch->>'image_count')::INTEGER, 0) ELSE 0 END,
         video_count = CASE WHEN v_status = 'DRAFT' THEN COALESCE((p_post_patch->>'video_count')::INTEGER, 0) ELSE 0 END,
         source_published_at = COALESCE(NULLIF(p_post_patch->>'source_published_at', '')::TIMESTAMPTZ, source_published_at),
         source_like_count = COALESCE(NULLIF(p_post_patch->>'source_like_count', '')::BIGINT, source_like_count),
         source_comment_count = COALESCE(NULLIF(p_post_patch->>'source_comment_count', '')::BIGINT, source_comment_count),
         source_play_count = COALESCE(NULLIF(p_post_patch->>'source_play_count', '')::BIGINT, source_play_count),
         source_metadata = COALESCE(p_post_patch->'source_metadata', source_metadata),
         file_size_bytes = GREATEST(0, COALESCE((p_post_patch->>'file_size_bytes')::BIGINT, file_size_bytes)),
         revision = v_new_rev,
         approved_revision = NULL,
         extracted_at = COALESCE(NULLIF(p_post_patch->>'extracted_at', '')::TIMESTAMPTZ, NOW()),
         uploaded_at = CASE WHEN v_status = 'DRAFT' THEN COALESCE(NULLIF(p_post_patch->>'uploaded_at', '')::TIMESTAMPTZ, NOW()) ELSE uploaded_at END,
         processed_at = NOW(),
         execution_id = COALESCE(NULLIF(p_execution_id, ''), execution_id),
         request_id = COALESCE(NULLIF(p_request_id, ''), request_id),
         sheets_sync_status = 'PENDING',
         error = COALESCE(p_post_patch->>'error', ''),
         error_code = COALESCE(p_post_patch->>'error_code', ''),
         error_stage = COALESCE(p_post_patch->>'error_stage', '')
   WHERE id = p_post_uuid
   RETURNING * INTO v_post;

  IF COALESCE(p_job_id, '') <> '' THEN
    UPDATE public.instaops_jobs
       SET status = CASE WHEN v_status = 'FAILED' THEN 'FAILED' ELSE 'COMPLETED' END,
           stage = CASE WHEN v_status = 'FAILED' THEN 'FAILED' ELSE 'COMPLETED' END,
           execution_id = COALESCE(NULLIF(p_execution_id, ''), execution_id),
           error_code = NULLIF(v_post.error_code, ''),
           error_message = NULLIF(v_post.error, ''),
           finished_at = NOW()
     WHERE job_id = p_job_id;
  END IF;

  INSERT INTO public.instaops_sync_queue (
    entity_type, entity_uuid, external_id, operation, payload, idempotency_key, source_revision
  )
  VALUES (
    'POST',
    v_post.id,
    v_post.post_id,
    'UPSERT',
    pg_catalog.jsonb_build_object('post_uuid', v_post.id, 'row', pg_catalog.to_jsonb(v_post)),
    'post:' || v_post.id::TEXT || ':rev' || v_post.revision::TEXT || ':' || v_status,
    v_post.revision
  )
  ON CONFLICT ON CONSTRAINT instaops_sync_queue_idempotency_key_key DO NOTHING;

  IF COALESCE(p_lock_key, '') <> '' AND COALESCE(p_lock_owner, '') <> '' THEN
    DELETE FROM public.instaops_job_locks WHERE lock_key = p_lock_key AND owner_id = p_lock_owner;
  END IF;

  RETURN v_post;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_finalize_deletion(
  p_post_uuid UUID,
  p_operation TEXT,
  p_confirmed_asset_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_failed_assets JSONB DEFAULT '[]'::jsonb,
  p_reason TEXT DEFAULT '',
  p_job_id TEXT DEFAULT '',
  p_lock_key TEXT DEFAULT '',
  p_lock_owner TEXT DEFAULT ''
)
RETURNS TABLE (
  post_uuid UUID,
  post_id TEXT,
  post_status TEXT,
  confirmed_count INTEGER,
  failed_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_post public.instaops_posts%ROWTYPE;
  v_confirmed_cnt INTEGER := 0;
  v_failed_cnt INTEGER := 0;
  v_active_left INTEGER := 0;
  v_fail JSONB;
  v_asset public.instaops_media_assets%ROWTYPE;
  v_lock_owner TEXT;
  v_lock_expires TIMESTAMPTZ;
BEGIN
  IF COALESCE(p_lock_key, '') <> '' OR COALESCE(p_lock_owner, '') <> '' THEN
    IF COALESCE(p_lock_key, '') = '' OR COALESCE(p_lock_owner, '') = '' THEN
      RAISE EXCEPTION 'Both p_lock_key and p_lock_owner are required when finalizing deletion with lock verification';
    END IF;
    SELECT jl.owner_id, jl.expires_at
      INTO v_lock_owner, v_lock_expires
      FROM public.instaops_job_locks AS jl
     WHERE jl.lock_key = p_lock_key
     FOR UPDATE;
    IF NOT FOUND OR v_lock_owner <> p_lock_owner OR v_lock_expires < NOW() THEN
      RAISE EXCEPTION 'Cannot finalize deletion: active lock % missing or expired for owner %', p_lock_key, p_lock_owner;
    END IF;
  END IF;

  SELECT * INTO v_post FROM public.instaops_posts AS p WHERE p.id = p_post_uuid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Post % not found', p_post_uuid;
  END IF;
  IF v_post.status IN ('PUBLISHING', 'VERIFY_MANUALLY') THEN
    RAISE EXCEPTION 'Cannot finalize deletion while post % is %', v_post.post_id, v_post.status;
  END IF;
  IF UPPER(COALESCE(p_operation, '')) = 'DELETE_POST' AND (v_post.status = 'PUBLISHED' OR COALESCE(v_post.published_id, '') <> '') THEN
    RAISE EXCEPTION 'Published post cannot be deleted; archive instead';
  END IF;

  IF pg_catalog.array_length(p_confirmed_asset_ids, 1) > 0 THEN
    FOR v_asset IN
      UPDATE public.instaops_media_assets
         SET storage_status = 'DELETED',
             deleted_at = COALESCE(deleted_at, NOW()),
             permanently_deleted_at = COALESCE(permanently_deleted_at, NOW()),
             error = ''
       WHERE public.instaops_media_assets.post_uuid = p_post_uuid
         AND public.instaops_media_assets.internal_asset_id = ANY(p_confirmed_asset_ids)
       RETURNING *
    LOOP
      v_confirmed_cnt := v_confirmed_cnt + 1;
      INSERT INTO public.instaops_sync_queue (
        entity_type, entity_uuid, external_id, operation, payload, idempotency_key, source_revision
      )
      VALUES (
        'MEDIA_ASSET',
        v_asset.id,
        v_asset.internal_asset_id,
        'DELETE_MEDIA',
        pg_catalog.jsonb_build_object('asset_uuid', v_asset.id, 'post_uuid', v_post.id, 'row', pg_catalog.to_jsonb(v_asset)),
        'delasset:' || v_asset.id::TEXT || ':' || pg_catalog.date_part('epoch', NOW())::BIGINT::TEXT,
        v_post.revision
      )
      ON CONFLICT ON CONSTRAINT instaops_sync_queue_idempotency_key_key DO NOTHING;
    END LOOP;
  END IF;

  IF pg_catalog.jsonb_typeof(p_failed_assets) = 'array' THEN
    v_failed_cnt := pg_catalog.jsonb_array_length(p_failed_assets);
    FOR v_fail IN SELECT value FROM pg_catalog.jsonb_array_elements(p_failed_assets) LOOP
      UPDATE public.instaops_media_assets
         SET storage_status = 'PARTIAL_DELETE',
             error = COALESCE(v_fail->>'error', 'Cloudinary destroy failed')
       WHERE public.instaops_media_assets.post_uuid = p_post_uuid
         AND public.instaops_media_assets.internal_asset_id = COALESCE(v_fail->>'internal_asset_id', '');
    END LOOP;
  END IF;

  SELECT COUNT(*) INTO v_active_left
    FROM public.instaops_media_assets AS ma
   WHERE ma.post_uuid = p_post_uuid AND ma.storage_status IN ('ACTIVE', 'DELETE_PENDING', 'PARTIAL_DELETE');

  IF v_failed_cnt > 0 THEN
    UPDATE public.instaops_posts
       SET status = CASE WHEN status = 'PUBLISHED' THEN status ELSE 'FAILED' END,
           approved_revision = NULL,
           error_code = 'CLOUDINARY_DELETE_FAILED',
           error_stage = 'DELETING_ASSETS',
           error = 'Partial Cloudinary deletion failure; retry failed asset(s) before deleting post.',
           sheets_sync_status = 'PENDING'
     WHERE id = p_post_uuid
     RETURNING * INTO v_post;
  ELSIF UPPER(COALESCE(p_operation, '')) = 'DELETE_POST' THEN
    IF v_active_left > 0 THEN
      RAISE EXCEPTION 'Cannot soft-delete post % while % unresolved asset(s) remain', v_post.post_id, v_active_left;
    END IF;
    UPDATE public.instaops_posts
       SET status = 'DELETED',
           deleted_at = NOW(),
           media_url = '',
           media_count = 0,
           image_count = 0,
           video_count = 0,
           approved_revision = NULL,
           sheets_sync_status = 'PENDING',
           error = CASE WHEN COALESCE(p_reason, '') <> '' THEN 'Soft-deleted: ' || p_reason ELSE '' END,
           error_code = '',
           error_stage = ''
     WHERE id = p_post_uuid
     RETURNING * INTO v_post;
  ELSIF v_active_left = 0 THEN
    UPDATE public.instaops_posts
       SET status = CASE WHEN status = 'PUBLISHED' THEN status ELSE 'MEDIA_DELETED' END,
           media_url = '',
           media_count = 0,
           image_count = 0,
           video_count = 0,
           approved_revision = NULL,
           sheets_sync_status = 'PENDING'
     WHERE id = p_post_uuid
     RETURNING * INTO v_post;
  END IF;

  INSERT INTO public.instaops_sync_queue (
    entity_type, entity_uuid, external_id, operation, payload, idempotency_key, source_revision
  )
  VALUES (
    'POST',
    v_post.id,
    v_post.post_id,
    CASE WHEN v_post.status = 'DELETED' THEN 'SOFT_DELETE' ELSE 'DELETE_MEDIA' END,
    pg_catalog.jsonb_build_object('post_uuid', v_post.id, 'row', pg_catalog.to_jsonb(v_post), 'reason', COALESCE(p_reason, '')),
    'delpost:' || v_post.id::TEXT || ':' || v_post.status || ':' || pg_catalog.date_part('epoch', NOW())::BIGINT::TEXT,
    v_post.revision
  )
  ON CONFLICT ON CONSTRAINT instaops_sync_queue_idempotency_key_key DO NOTHING;

  INSERT INTO public.instaops_audit_events (post_uuid, entity_type, entity_id, action, details)
  VALUES (
    v_post.id,
    'POST',
    v_post.post_id,
    UPPER(COALESCE(p_operation, 'DELETE_MEDIA')),
    pg_catalog.jsonb_build_object('confirmed', v_confirmed_cnt, 'failed', v_failed_cnt, 'reason', COALESCE(p_reason, ''))
  );

  IF COALESCE(p_job_id, '') <> '' THEN
    UPDATE public.instaops_jobs
       SET status = CASE WHEN v_failed_cnt > 0 THEN 'FAILED' ELSE 'COMPLETED' END,
           stage = CASE WHEN v_failed_cnt > 0 THEN 'FAILED' ELSE 'COMPLETED' END,
           error_code = CASE WHEN v_failed_cnt > 0 THEN 'CLOUDINARY_DELETE_FAILED' ELSE NULL END,
           error_message = CASE WHEN v_failed_cnt > 0 THEN 'Partial deletion failure' ELSE NULL END,
           finished_at = NOW()
     WHERE job_id = p_job_id;
  END IF;

  IF COALESCE(p_lock_key, '') <> '' AND COALESCE(p_lock_owner, '') <> '' THEN
    DELETE FROM public.instaops_job_locks WHERE lock_key = p_lock_key AND owner_id = p_lock_owner;
  END IF;

  RETURN QUERY SELECT v_post.id, v_post.post_id, v_post.status, v_confirmed_cnt, v_failed_cnt;
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
  IF EXISTS (
    SELECT 1 FROM public.instaops_media_assets AS ma
     WHERE ma.post_uuid = p_post_uuid
       AND ma.storage_status IN ('ACTIVE', 'DELETE_PENDING', 'PARTIAL_DELETE')
  ) THEN
    RAISE EXCEPTION 'Cannot soft-delete post % while unresolved media assets remain', v_post.post_id;
  END IF;

  UPDATE public.instaops_posts
     SET status = 'DELETED',
         deleted_at = NOW(),
         approved_revision = NULL,
         sheets_sync_status = 'PENDING',
         error = CASE WHEN COALESCE(p_reason, '') <> '' THEN 'Soft-deleted: ' || p_reason ELSE error END
   WHERE id = p_post_uuid
   RETURNING * INTO v_post;

  INSERT INTO public.instaops_sync_queue (entity_type, entity_uuid, external_id, operation, payload, idempotency_key, source_revision)
  VALUES (
    'POST',
    v_post.id,
    v_post.post_id,
    'SOFT_DELETE',
    pg_catalog.jsonb_build_object('post_uuid', v_post.id, 'post_id', v_post.post_id, 'status', v_post.status, 'deleted_at', v_post.deleted_at, 'reason', COALESCE(p_reason, ''), 'row', pg_catalog.to_jsonb(v_post)),
    'soft_del:' || v_post.id::TEXT || ':' || pg_catalog.date_part('epoch', NOW())::BIGINT::TEXT,
    v_post.revision
  )
  ON CONFLICT ON CONSTRAINT instaops_sync_queue_idempotency_key_key DO NOTHING;

  INSERT INTO public.instaops_audit_events (post_uuid, entity_type, entity_id, action, details)
  VALUES (v_post.id, 'POST', v_post.post_id, 'SOFT_DELETE', pg_catalog.jsonb_build_object('reason', COALESCE(p_reason, '')));

  RETURN v_post;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_recover_stale_sync_jobs(
  p_stale_seconds INTEGER DEFAULT 180
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sec INTEGER := GREATEST(30, LEAST(86400, COALESCE(p_stale_seconds, 180)));
  v_count INTEGER := 0;
BEGIN
  UPDATE public.instaops_sync_queue
     SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD_LETTER' ELSE 'FAILED' END,
         locked_by = NULL,
         next_retry_at = NOW(),
         last_error = COALESCE(NULLIF(last_error, ''), 'Recovered abandoned sync job lock after timeout/restart')
   WHERE status = 'PROCESSING'
     AND COALESCE(locked_at, updated_at) < NOW() - (v_sec::TEXT || ' seconds')::INTERVAL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

DROP FUNCTION IF EXISTS public.instaops_claim_sync_batch(TEXT, INTEGER);
CREATE OR REPLACE FUNCTION public.instaops_claim_sync_batch(
  p_worker_id TEXT,
  p_batch_size INTEGER DEFAULT 10,
  p_stale_seconds INTEGER DEFAULT 180
)
RETURNS SETOF public.instaops_sync_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.instaops_recover_stale_sync_jobs(p_stale_seconds);

  UPDATE public.instaops_sync_queue AS sq
     SET status = 'SUCCEEDED',
         locked_by = NULL,
         last_error = 'Superseded by newer post revision'
    FROM public.instaops_posts AS p
   WHERE sq.entity_type = 'POST'
     AND sq.entity_uuid = p.id
     AND sq.status IN ('PENDING', 'FAILED')
     AND sq.source_revision > 0
     AND p.revision > sq.source_revision;

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

CREATE OR REPLACE FUNCTION public.instaops_get_runtime_settings()
RETURNS TABLE (
  setting_key TEXT,
  live_publish_enabled BOOLEAN,
  live_delete_enabled BOOLEAN,
  scheduling_enabled BOOLEAN,
  updated_by TEXT,
  change_reason TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.instaops_runtime_settings (
    setting_key, live_publish_enabled, live_delete_enabled, scheduling_enabled, updated_by, change_reason
  ) VALUES (
    'default', false, false, false, 'auto_seed', 'Auto-initialized safe-disabled runtime settings'
  )
  ON CONFLICT ON CONSTRAINT instaops_runtime_settings_pkey DO NOTHING;

  RETURN QUERY
  SELECT
    rs.setting_key,
    rs.live_publish_enabled,
    rs.live_delete_enabled,
    rs.scheduling_enabled,
    rs.updated_by,
    rs.change_reason,
    rs.updated_at
  FROM public.instaops_runtime_settings AS rs
  WHERE rs.setting_key = 'default';
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_update_runtime_settings(
  p_live_publish_enabled BOOLEAN DEFAULT NULL,
  p_live_delete_enabled BOOLEAN DEFAULT NULL,
  p_scheduling_enabled BOOLEAN DEFAULT NULL,
  p_updated_by TEXT DEFAULT 'operator',
  p_change_reason TEXT DEFAULT ''
)
RETURNS public.instaops_runtime_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev public.instaops_runtime_settings%ROWTYPE;
  v_next public.instaops_runtime_settings%ROWTYPE;
BEGIN
  INSERT INTO public.instaops_runtime_settings (
    setting_key, live_publish_enabled, live_delete_enabled, scheduling_enabled, updated_by, change_reason
  ) VALUES (
    'default', false, false, false, 'auto_seed', 'Auto-initialized safe-disabled runtime settings'
  )
  ON CONFLICT (setting_key) DO NOTHING;

  SELECT * INTO v_prev
    FROM public.instaops_runtime_settings
   WHERE setting_key = 'default'
   FOR UPDATE;

  UPDATE public.instaops_runtime_settings
     SET live_publish_enabled = COALESCE(p_live_publish_enabled, live_publish_enabled),
         live_delete_enabled = COALESCE(p_live_delete_enabled, live_delete_enabled),
         scheduling_enabled = COALESCE(p_scheduling_enabled, scheduling_enabled),
         updated_by = COALESCE(NULLIF(p_updated_by, ''), 'operator'),
         change_reason = COALESCE(p_change_reason, '')
   WHERE setting_key = 'default'
   RETURNING * INTO v_next;

  INSERT INTO public.instaops_audit_events (
    post_uuid, entity_type, entity_id, action, actor, details
  ) VALUES (
    NULL,
    'SYSTEM',
    'runtime_settings:default',
    'UPDATE_RUNTIME_SETTINGS',
    COALESCE(NULLIF(p_updated_by, ''), 'operator'),
    pg_catalog.jsonb_build_object(
      'reason', COALESCE(p_change_reason, ''),
      'previous', pg_catalog.jsonb_build_object(
        'live_publish_enabled', v_prev.live_publish_enabled,
        'live_delete_enabled', v_prev.live_delete_enabled,
        'scheduling_enabled', v_prev.scheduling_enabled
      ),
      'current', pg_catalog.jsonb_build_object(
        'live_publish_enabled', v_next.live_publish_enabled,
        'live_delete_enabled', v_next.live_delete_enabled,
        'scheduling_enabled', v_next.scheduling_enabled
      )
    )
  );

  RETURN v_next;
END;
$$;

CREATE OR REPLACE FUNCTION public.instaops_verify_health_and_rpc()
RETURNS TABLE (
  schema_ok BOOLEAN,
  rls_ok BOOLEAN,
  anon_revoked_ok BOOLEAN,
  atomic_rpc_ok BOOLEAN,
  tables_count INTEGER,
  active_accounts_count INTEGER,
  detail TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_tables INTEGER := 0;
  v_rls_cnt INTEGER := 0;
  v_anon_open INTEGER := 0;
  v_accounts INTEGER := 0;
  v_rpc_ok BOOLEAN := false;
  v_acq BOOLEAN := false;
  v_ren BOOLEAN := false;
  v_exp_ren BOOLEAN := true;
  v_rel BOOLEAN := false;
  v_rs_cnt INTEGER := 0;
  v_rpc_err TEXT := '';
  v_probe_key TEXT := '__healthcheck__:self_test:' || substr(replace(pg_catalog.gen_random_uuid()::TEXT, '-', ''), 1, 8);
  v_probe_owner TEXT := 'health_' || substr(replace(pg_catalog.gen_random_uuid()::TEXT, '-', ''), 1, 8);
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (WHERE c.relrowsecurity = true),
         COUNT(*) FILTER (WHERE pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') OR pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'))
    INTO v_tables, v_rls_cnt, v_anon_open
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relname = ANY(ARRAY[
       'instaops_accounts',
       'instaops_posts',
       'instaops_media_assets',
       'instaops_post_revisions',
       'instaops_jobs',
       'instaops_job_locks',
       'instaops_idempotency_keys',
       'instaops_execution_logs',
       'instaops_sync_queue',
       'instaops_audit_events',
       'instaops_runtime_settings'
     ]);

  SELECT COUNT(*) INTO v_accounts FROM public.instaops_accounts WHERE enabled = true;

  BEGIN
    SELECT al.acquired INTO v_acq
      FROM public.instaops_acquire_lock(v_probe_key, NULL::UUID, 'HEALTHCHECK', 'RETRY', v_probe_owner, v_probe_owner, 30) AS al;
    SELECT rl.renewed INTO v_ren
      FROM public.instaops_renew_lock(v_probe_key, v_probe_owner, 45) AS rl;
    UPDATE public.instaops_job_locks
       SET expires_at = NOW() - INTERVAL '5 seconds'
     WHERE lock_key = v_probe_key
       AND owner_id = v_probe_owner;
    SELECT rl.renewed INTO v_exp_ren
      FROM public.instaops_renew_lock(v_probe_key, v_probe_owner, 45) AS rl;
    DELETE FROM public.instaops_job_locks
     WHERE lock_key = v_probe_key
       AND owner_id = v_probe_owner;
    v_rel := FOUND;
    SELECT COUNT(*) INTO v_rs_cnt FROM public.instaops_get_runtime_settings();
    v_rpc_ok := COALESCE(v_acq, false) AND COALESCE(v_ren, false) AND (NOT COALESCE(v_exp_ren, true)) AND COALESCE(v_rel, false) AND v_rs_cnt = 1;
  EXCEPTION WHEN OTHERS THEN
    v_rpc_ok := false;
    v_rpc_err := SQLERRM;
  END;

  RETURN QUERY SELECT
    (v_tables = 11),
    (v_tables = 11 AND v_rls_cnt = 11),
    (v_tables = 11 AND v_anon_open = 0),
    v_rpc_ok,
    v_tables,
    v_accounts,
    ('tables=' || v_tables || '/11, rls=' || v_rls_cnt || '/11, anon_open=' || v_anon_open || ', rpc_ok=' || v_rpc_ok
     || CASE WHEN NOT v_rpc_ok THEN ', state=' || COALESCE(v_acq::TEXT, 'null') || '/' || COALESCE(v_ren::TEXT, 'null') || '/' || COALESCE(v_exp_ren::TEXT, 'null') || '/' || COALESCE(v_rel::TEXT, 'null') || '/rs=' || v_rs_cnt::TEXT ELSE '' END
     || CASE WHEN v_rpc_err <> '' THEN ', err=' || v_rpc_err ELSE '' END)::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.instaops_get_runtime_settings() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_update_runtime_settings(BOOLEAN, BOOLEAN, BOOLEAN, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_acquire_lock(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_transfer_or_claim_lock(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_renew_lock(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_release_lock(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_release_stale_locks() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_claim_idempotency(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_complete_idempotency(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_approve_post_revision(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_claim_due_scheduled_posts(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_finalize_extraction(UUID, JSONB, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_finalize_deletion(UUID, TEXT, TEXT[], JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_soft_delete_post(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_recover_stale_sync_jobs(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_claim_sync_batch(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.instaops_verify_health_and_rpc() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.instaops_acquire_lock(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_transfer_or_claim_lock(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_renew_lock(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_release_lock(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_release_stale_locks() TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_claim_idempotency(TEXT, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_complete_idempotency(TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_approve_post_revision(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_claim_due_scheduled_posts(TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_finalize_extraction(UUID, JSONB, JSONB, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_finalize_deletion(UUID, TEXT, TEXT[], JSONB, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_soft_delete_post(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_recover_stale_sync_jobs(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_claim_sync_batch(TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_verify_health_and_rpc() TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_get_runtime_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_update_runtime_settings(BOOLEAN, BOOLEAN, BOOLEAN, TEXT, TEXT) TO service_role;

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
ALTER TABLE public.instaops_runtime_settings ENABLE ROW LEVEL SECURITY;

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
REVOKE ALL ON TABLE public.instaops_runtime_settings FROM PUBLIC, anon, authenticated;

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
GRANT ALL ON TABLE public.instaops_runtime_settings TO service_role;

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

DROP POLICY IF EXISTS "deny_client_runtime_settings" ON public.instaops_runtime_settings;
CREATE POLICY "deny_client_runtime_settings" ON public.instaops_runtime_settings AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "service_runtime_settings" ON public.instaops_runtime_settings;
CREATE POLICY "service_runtime_settings" ON public.instaops_runtime_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMIT;
