-- =============================================================================
-- InstaOps v2.0 Non-Destructive Reliability Upgrade (Migration 007)
-- 1. Enforce active non-expired ownership on lock renewal and finalizations.
-- 2. Add operator-controlled, audited public.instaops_runtime_settings table + RPCs
--    (defaulting safe-disabled: live_publish=false, live_delete=false, scheduling=false)
--    so W02/W03/W04/W05 workflows enforce gates directly from Supabase without $env.
-- Safe to run on an existing production database via Supabase SQL Editor.
-- =============================================================================

BEGIN;

-- 1. Runtime operational safety settings (strictly locked to service_role)
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
  setting_key,
  live_publish_enabled,
  live_delete_enabled,
  scheduling_enabled,
  updated_by,
  change_reason
) VALUES (
  'default',
  false,
  false,
  false,
  'migration_007',
  'Default fail-closed safety gates'
)
ON CONFLICT (setting_key) DO NOTHING;

DROP TRIGGER IF EXISTS trg_instaops_runtime_settings_updated_at ON public.instaops_runtime_settings;
CREATE TRIGGER trg_instaops_runtime_settings_updated_at
  BEFORE UPDATE ON public.instaops_runtime_settings
  FOR EACH ROW EXECUTE FUNCTION public.instaops_touch_updated_at();

ALTER TABLE public.instaops_runtime_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instaops_runtime_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.instaops_runtime_settings TO service_role;

DROP POLICY IF EXISTS "deny_client_runtime_settings" ON public.instaops_runtime_settings;
CREATE POLICY "deny_client_runtime_settings"
  ON public.instaops_runtime_settings
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "service_runtime_settings" ON public.instaops_runtime_settings;
CREATE POLICY "service_runtime_settings"
  ON public.instaops_runtime_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

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
    setting_key,
    live_publish_enabled,
    live_delete_enabled,
    scheduling_enabled,
    updated_by,
    change_reason
  ) VALUES (
    'default',
    false,
    false,
    false,
    'auto_seed',
    'Auto-initialized safe-disabled runtime settings'
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
    setting_key,
    live_publish_enabled,
    live_delete_enabled,
    scheduling_enabled,
    updated_by,
    change_reason
  ) VALUES (
    'default',
    false,
    false,
    false,
    'auto_seed',
    'Auto-initialized safe-disabled runtime settings'
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

-- 2. Refuse renewing already-expired locks
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

-- 3. Verify active non-expired lock ownership BEFORE extraction mutations
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

-- 4. Verify active non-expired lock ownership BEFORE deletion mutations
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

-- 5. Expand health & atomic RPC self-test to cover all 11 tables + expired-lock guard
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

    -- Confirm expired locks cannot be renewed
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
GRANT EXECUTE ON FUNCTION public.instaops_get_runtime_settings() TO service_role;
GRANT EXECUTE ON FUNCTION public.instaops_update_runtime_settings(BOOLEAN, BOOLEAN, BOOLEAN, TEXT, TEXT) TO service_role;

COMMIT;
