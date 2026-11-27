-- 004_functions_and_locking.sql
-- Transactional RPCs for Postgres atomic locking, idempotency, soft deletion, and sync queue claiming.
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

-- Lock down all transactional RPCs from PUBLIC / anon / authenticated roles
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
