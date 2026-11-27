-- 004_functions_and_locking.sql
-- Transactional RPCs for Postgres atomic locking, transfer, renewal, manual approval,
-- scheduled claims, extraction/deletion finalization, outbox recovery, and health diagnostics.
-- Security rule: search_path locked to empty string and EXECUTE revoked from PUBLIC/anon/authenticated.

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
BEGIN
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
BEGIN
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
  v_rel BOOLEAN := false;
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
       'instaops_audit_events'
     ]);

  SELECT COUNT(*) INTO v_accounts FROM public.instaops_accounts WHERE enabled = true;

  BEGIN
    SELECT al.acquired INTO v_acq
      FROM public.instaops_acquire_lock(v_probe_key, NULL::UUID, 'HEALTHCHECK', 'RETRY', v_probe_owner, v_probe_owner, 30) AS al;
    SELECT rl.renewed INTO v_ren
      FROM public.instaops_renew_lock(v_probe_key, v_probe_owner, 45) AS rl;
    SELECT public.instaops_release_lock(v_probe_key, v_probe_owner) INTO v_rel;
    v_rpc_ok := COALESCE(v_acq, false) AND COALESCE(v_ren, false) AND COALESCE(v_rel, false);
  EXCEPTION WHEN OTHERS THEN
    v_rpc_ok := false;
  END;

  RETURN QUERY SELECT
    (v_tables = 10),
    (v_tables = 10 AND v_rls_cnt = 10),
    (v_tables = 10 AND v_anon_open = 0),
    v_rpc_ok,
    v_tables,
    v_accounts,
    ('tables=' || v_tables || '/10, rls=' || v_rls_cnt || '/10, anon_open=' || v_anon_open || ', rpc_ok=' || v_rpc_ok)::TEXT;
END;
$$;

-- Lock down all transactional RPCs from PUBLIC / anon / authenticated roles
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
