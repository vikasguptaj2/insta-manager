-- 002_core_tables.sql
-- Relational Supabase PostgreSQL schema for InstaOps v2.0 (primary application source of truth).
-- All core entities use permanent UUID primary keys (`id`) plus durable human/external IDs (`post_id`, `internal_asset_id`).

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
