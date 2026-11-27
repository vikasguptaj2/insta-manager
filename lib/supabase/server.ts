import crypto from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  ContentRecord,
  DurableJob,
  ExecutionLogRecord,
  JobLock,
  JobOperation,
  MediaAssetRecord,
  SyncQueueRecord,
} from '../../types/instaops';
import { getConfig } from '../config/env';
import { AppError } from '../errors/codes';
import { normalizeContentRecord, normalizeExecutionLogRecord, normalizeMediaAssetRecord, toSafeSheetRow } from '../domain/schema';
import type { IdempotencyClaimResult, LockAcquireInput, LockStore } from '../jobs/lock-store';

if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  throw new Error('SECURITY VIOLATION: lib/supabase/server.ts is server-only and must never run in client bundles.');
}

function isUuid(val: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val.trim());
}

export function createSupabaseAdminClient(fetchImpl?: typeof fetch): SupabaseClient {
  const cfg = getConfig();
  if (!cfg.supabaseUrl || !cfg.supabaseServiceRoleKey) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'SUPABASE_URL and server-only SUPABASE_SERVICE_ROLE_KEY are required for live Supabase access.',
      { httpStatus: 500 },
    );
  }
  return createClient(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: fetchImpl ? { fetch: fetchImpl } : undefined,
  });
}

function rowToContentRecord(raw: Record<string, unknown>): ContentRecord {
  const rec = normalizeContentRecord({
    ...raw,
    id: raw.id ? String(raw.id) : '',
    hashtags_json: Array.isArray(raw.hashtags) ? JSON.stringify(raw.hashtags) : raw.hashtags_json,
    mentions_json: Array.isArray(raw.mentions) ? JSON.stringify(raw.mentions) : raw.mentions_json,
    source_metadata_json:
      raw.source_metadata && typeof raw.source_metadata === 'object'
        ? JSON.stringify(raw.source_metadata)
        : raw.source_metadata_json,
    child_container_ids: Array.isArray(raw.child_container_ids)
      ? JSON.stringify(raw.child_container_ids)
      : raw.child_container_ids,
    approved_revision: raw.approved_revision ?? '',
  });
  if (raw.id) rec.id = String(raw.id);
  if (raw.sheets_sync_status) rec.sheets_sync_status = String(raw.sheets_sync_status) as ContentRecord['sheets_sync_status'];
  if (raw.sheets_synced_at) rec.sheets_synced_at = String(raw.sheets_synced_at);
  if (raw.sheets_sync_error !== undefined) rec.sheets_sync_error = String(raw.sheets_sync_error ?? '');
  return rec;
}

function contentRecordToDbPayload(rec: ContentRecord): Record<string, unknown> {
  const toNullableIso = (v?: string): string | null => {
    const s = (v ?? '').trim();
    if (!s) return null;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const toNullableInt = (v?: string): number | null => {
    const s = (v ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };
  const parseJson = <T>(raw: string | undefined, fallback: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  };

  return {
    id: rec.id && isUuid(rec.id) ? rec.id : crypto.randomUUID(),
    post_id: rec.post_id,
    account_key: rec.account_key || 'A',
    ig_user_id: rec.ig_user_id || '17841453414532595',
    source_instagram_url: rec.source_instagram_url,
    canonical_url: rec.canonical_url || '',
    source_id: rec.source_id || '',
    source_username: rec.source_username || '',
    source_kind: rec.source_kind || '',
    media_type: rec.media_type,
    media_url: rec.media_url || '',
    original_caption: rec.original_caption || '',
    caption: rec.caption || '',
    caption_status: rec.caption_status || 'unknown',
    caption_source: rec.caption_source || '',
    hashtags: parseJson<string[]>(rec.hashtags_json, []),
    mentions: parseJson<string[]>(rec.mentions_json, []),
    media_count: Number(rec.media_count) || 0,
    image_count: Number(rec.image_count) || 0,
    video_count: Number(rec.video_count) || 0,
    source_published_at: toNullableIso(rec.source_published_at),
    source_like_count: toNullableInt(rec.source_like_count),
    source_comment_count: toNullableInt(rec.source_comment_count),
    source_play_count: toNullableInt(rec.source_play_count),
    source_metadata: parseJson<Record<string, unknown>>(rec.source_metadata_json, {}),
    file_size_bytes: Number(rec.file_size_bytes) || 0,
    publish_mode: rec.publish_mode || 'NOW',
    publish_at: toNullableIso(rec.publish_at),
    status: rec.status || 'DRAFT',
    revision: Math.max(1, Number(rec.revision) || 1),
    approved_revision: toNullableInt(rec.approved_revision),
    container_id: rec.container_id || '',
    child_container_ids: parseJson<string[]>(rec.child_container_ids, []),
    published_id: rec.published_id || '',
    published_url: rec.published_url || '',
    published_at: toNullableIso(rec.published_at),
    processed_at: toNullableIso(rec.processed_at),
    execution_id: rec.execution_id || '',
    request_id: rec.request_id || '',
    retry_count: Number(rec.retry_count) || 0,
    error: rec.error || '',
    error_code: rec.error_code || '',
    error_stage: rec.error_stage || '',
    sheets_sync_status: rec.sheets_sync_status ?? 'PENDING',
    sheets_synced_at: toNullableIso(rec.sheets_synced_at),
    sheets_sync_error: rec.sheets_sync_error ?? '',
    schema_version: rec.schema_version || '2.0',
    extracted_at: toNullableIso(rec.extracted_at),
    uploaded_at: toNullableIso(rec.uploaded_at),
    archived_at: toNullableIso(rec.archived_at),
    deleted_at: toNullableIso(rec.deleted_at),
  };
}

export class SupabaseLockStore implements LockStore {
  readonly mode = 'supabase' as const;
  private readonly client: SupabaseClient;
  private verified = false;

  constructor(fetchImpl?: typeof fetch, clientOverride?: SupabaseClient) {
    this.client = clientOverride ?? createSupabaseAdminClient(fetchImpl);
  }

  async ensureSchema(): Promise<void> {
    if (this.verified) return;
    const { error } = await this.client.from('instaops_job_locks').select('lock_key').limit(1);
    if (error) {
      throw new AppError(
        'CONFIGURATION_ERROR',
        `Supabase schema missing or inaccessible (${error.message}). Execute supabase/INSTALL_FRESH.sql in Supabase SQL Editor.`,
        { httpStatus: 500 },
      );
    }
    this.verified = true;
  }

  async acquireLock(input: LockAcquireInput): Promise<JobLock> {
    await this.ensureSchema();
    const { data: postRow } = await this.client
      .from('instaops_posts')
      .select('id')
      .eq('post_id', input.post_id)
      .maybeSingle();

    const postUuid = postRow && typeof postRow.id === 'string' ? postRow.id : null;
    const { data, error } = await this.client.rpc('instaops_acquire_lock', {
      p_lock_key: input.lock_key,
      p_post_uuid: postUuid,
      p_post_id: input.post_id,
      p_operation: input.operation,
      p_owner_id: input.owner_id,
      p_request_id: input.request_id,
      p_lease_seconds: Math.max(15, Math.min(3600, input.leaseSeconds ?? 300)),
    });

    if (error) {
      throw new AppError('LOCK_ACQUISITION_FAILED', `Supabase lock RPC error: ${error.message}`, {
        httpStatus: 500,
      });
    }

    const rows = Array.isArray(data) ? data : [data];
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row || row.acquired !== true) {
      throw new AppError(
        'POST_LOCKED',
        `Post ${input.post_id} is locked by active operation (${String(row?.operation ?? 'UNKNOWN')}).`,
        {
          httpStatus: 409,
          details: { owner_id: row?.owner_id, expires_at: row?.expires_at },
        },
      );
    }

    return {
      lock_key: String(row.lock_key),
      post_id: String(row.post_id),
      operation: String(row.operation) as JobOperation,
      owner_id: String(row.owner_id),
      request_id: String(row.request_id),
      acquired_at: String(row.acquired_at),
      expires_at: String(row.expires_at),
    };
  }

  async releaseLock(lockKey: string, ownerId: string): Promise<boolean> {
    const { data, error } = await this.client.rpc('instaops_release_lock', {
      p_lock_key: lockKey,
      p_owner_id: ownerId,
    });
    if (error) return false;
    return data === true;
  }

  async listActiveLocks(): Promise<JobLock[]> {
    const { data, error } = await this.client
      .from('instaops_job_locks')
      .select('lock_key, post_id, operation, owner_id, request_id, acquired_at, expires_at')
      .gte('expires_at', new Date().toISOString())
      .order('acquired_at', { ascending: false });
    if (error || !data) return [];
    return data as JobLock[];
  }

  async releaseStaleLocks(): Promise<number> {
    const { data, error } = await this.client.rpc('instaops_release_stale_locks');
    if (error) return 0;
    return typeof data === 'number' ? data : 0;
  }

  async claimIdempotency<T = unknown>(
    key: string,
    requestHash: string,
    ttlSeconds = 86_400,
  ): Promise<IdempotencyClaimResult<T>> {
    await this.ensureSchema();
    const { data, error } = await this.client.rpc('instaops_claim_idempotency', {
      p_idem_key: key,
      p_request_hash: requestHash,
      p_ttl_seconds: ttlSeconds,
    });
    if (error) {
      throw new AppError('LOCK_ACQUISITION_FAILED', `Idempotency claim failed: ${error.message}`, {
        httpStatus: 500,
      });
    }
    const rows = Array.isArray(data) ? data : [data];
    const row = rows[0] as { claimed?: boolean; existing_state?: string; existing_response?: T } | undefined;
    if (row?.claimed) return { claimed: true };
    return {
      claimed: false,
      existingState: row?.existing_state,
      existingResponse: row?.existing_response,
    };
  }

  async completeIdempotency(key: string, status: 'SUCCEEDED' | 'FAILED', response: unknown): Promise<void> {
    await this.client.rpc('instaops_complete_idempotency', {
      p_idem_key: key,
      p_state: status,
      p_response: response ?? null,
    });
  }

  async saveJob(job: DurableJob): Promise<DurableJob> {
    await this.ensureSchema();
    const { data: postRow } = await this.client
      .from('instaops_posts')
      .select('id')
      .eq('post_id', job.post_id)
      .maybeSingle();

    const payload = {
      job_id: job.job_id,
      post_uuid: postRow && typeof postRow.id === 'string' ? postRow.id : null,
      post_id: job.post_id,
      request_id: job.request_id,
      execution_id: job.execution_id,
      operation: job.operation,
      stage: job.stage,
      status: job.status,
      error_code: job.error_code ?? null,
      error_message: job.error_message ?? null,
      finished_at: job.finished_at ?? null,
    };

    const { data, error } = await this.client
      .from('instaops_jobs')
      .upsert(payload, { onConflict: 'job_id' })
      .select('job_id, request_id, execution_id, post_id, operation, stage, status, error_code, error_message, created_at, updated_at, finished_at')
      .single();

    if (error || !data) {
      return job;
    }
    return data as DurableJob;
  }

  async getJob(jobId: string): Promise<DurableJob | null> {
    const { data, error } = await this.client
      .from('instaops_jobs')
      .select('job_id, request_id, execution_id, post_id, operation, stage, status, error_code, error_message, created_at, updated_at, finished_at')
      .eq('job_id', jobId)
      .maybeSingle();
    if (error || !data) return null;
    return data as DurableJob;
  }

  async listJobs(limit = 50): Promise<DurableJob[]> {
    const { data, error } = await this.client
      .from('instaops_jobs')
      .select('job_id, request_id, execution_id, post_id, operation, stage, status, error_code, error_message, created_at, updated_at, finished_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as DurableJob[];
  }

  async close(): Promise<void> {
    // Stateless HTTPS REST client requires no socket close.
  }
}

export class SupabaseRepository {
  private readonly client: SupabaseClient;

  constructor(fetchImpl?: typeof fetch, clientOverride?: SupabaseClient) {
    this.client = clientOverride ?? createSupabaseAdminClient(fetchImpl);
  }

  async checkHealth(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const t0 = Date.now();
    try {
      const { error, count } = await this.client
        .from('instaops_accounts')
        .select('id', { count: 'exact', head: true });
      const latencyMs = Date.now() - t0;
      if (error) {
        return {
          ok: false,
          detail: `Schema/API error: ${error.message} (verify supabase/INSTALL_FRESH.sql ran)`,
          latencyMs,
        };
      }
      return {
        ok: true,
        detail: `Connected primary PostgreSQL (${count ?? 0} account(s), RLS active)`,
        latencyMs,
      };
    } catch (e) {
      return {
        ok: false,
        detail: e instanceof Error ? e.message : 'Supabase probe failed',
        latencyMs: Date.now() - t0,
      };
    }
  }

  async listPosts(includeDeleted = false): Promise<ContentRecord[]> {
    let query = this.client
      .from('instaops_posts')
      .select('*')
      .order('updated_at', { ascending: false });
    if (!includeDeleted) {
      query = query.is('deleted_at', null);
    }
    const { data, error } = await query;
    if (error) {
      throw new AppError('CONFIGURATION_ERROR', `Supabase read posts failed: ${error.message}`, { httpStatus: 502 });
    }
    return (data ?? []).map((r: Record<string, unknown>) => rowToContentRecord(r));
  }

  async getPostByIdOrUuid(idOrUuid: string): Promise<ContentRecord | null> {
    const col = isUuid(idOrUuid) ? 'id' : 'post_id';
    const { data, error } = await this.client.from('instaops_posts').select('*').eq(col, idOrUuid).maybeSingle();
    if (error || !data) return null;
    return rowToContentRecord(data as Record<string, unknown>);
  }

  async listMediaAssets(postId?: string): Promise<MediaAssetRecord[]> {
    let query = this.client
      .from('instaops_media_assets')
      .select('*')
      .order('media_index', { ascending: true });
    if (postId) query = query.eq('post_id', postId);
    const { data, error } = await query;
    if (error) {
      throw new AppError('CONFIGURATION_ERROR', `Supabase read media_assets failed: ${error.message}`, {
        httpStatus: 502,
      });
    }
    return (data ?? []).map((r: Record<string, unknown>) => {
      const rec = normalizeMediaAssetRecord(r);
      if (r.id) rec.id = String(r.id);
      if (r.post_uuid) rec.post_uuid = String(r.post_uuid);
      if (r.ig_child_container_id) {
        rec.ig_child_container_id = String(r.ig_child_container_id);
      }
      return rec;
    });
  }

  async listExecutionLogs(limit = 100): Promise<ExecutionLogRecord[]> {
    const { data, error } = await this.client
      .from('instaops_execution_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data ?? []).map((r: Record<string, unknown>) => normalizeExecutionLogRecord(r));
  }

  async listSyncQueue(limit = 50): Promise<SyncQueueRecord[]> {
    const { data, error } = await this.client
      .from('instaops_sync_queue')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as SyncQueueRecord[];
  }

  async createPost(record: ContentRecord): Promise<ContentRecord> {
    const payload = contentRecordToDbPayload({
      ...record,
      id: record.id && isUuid(record.id) ? record.id : crypto.randomUUID(),
      sheets_sync_status: 'PENDING',
    });

    const { data, error } = await this.client
      .from('instaops_posts')
      .insert(payload)
      .select('*')
      .single();

    if (error || !data) {
      const dup = error?.code === '23505';
      throw new AppError(
        dup ? 'DUPLICATE_SOURCE' : 'CONFIGURATION_ERROR',
        dup ? 'Duplicate post ID or active Instagram source shortcode.' : `Supabase create post failed: ${error?.message}`,
        { httpStatus: dup ? 409 : 500 },
      );
    }

    const saved = rowToContentRecord(data as Record<string, unknown>);
    await this.recordRevision(saved, 'CREATE');
    await this.enqueueSyncEvent({
      entityType: 'POST',
      entityUuid: saved.id!,
      externalId: saved.post_id,
      operation: 'UPSERT',
      payload: { row: toSafeSheetRow(saved), post_uuid: saved.id },
      idempotencyKey: `post:${saved.id}:rev${saved.revision}:create`,
    });
    await this.auditEvent(saved.id!, 'POST', saved.post_id, 'CREATE_POST', { source_id: saved.source_id });
    return saved;
  }

  async updatePost(record: ContentRecord, changeSource = 'STUDIO'): Promise<ContentRecord> {
    const existing = record.id && isUuid(record.id) ? null : await this.getPostByIdOrUuid(record.post_id);
    const permanentId = (record.id && isUuid(record.id) ? record.id : existing?.id) ?? crypto.randomUUID();
    const payload = contentRecordToDbPayload({
      ...record,
      id: permanentId,
      sheets_sync_status: 'PENDING',
    });
    delete payload.id;

    const { data, error } = await this.client
      .from('instaops_posts')
      .update(payload)
      .eq('id', permanentId)
      .select('*')
      .single();

    if (error || !data) {
      throw new AppError('POST_NOT_FOUND', `Failed updating post ${record.post_id}: ${error?.message}`, {
        httpStatus: 404,
      });
    }

    const saved = rowToContentRecord(data as Record<string, unknown>);
    await this.recordRevision(saved, changeSource);
    await this.enqueueSyncEvent({
      entityType: 'POST',
      entityUuid: saved.id!,
      externalId: saved.post_id,
      operation: saved.status === 'ARCHIVED' ? 'ARCHIVE' : 'UPSERT',
      payload: { row: toSafeSheetRow(saved), post_uuid: saved.id },
      idempotencyKey: `post:${saved.id}:rev${saved.revision}:${saved.status}:${Date.now()}`,
    });
    await this.auditEvent(saved.id!, 'POST', saved.post_id, `UPDATE_${changeSource}`, { status: saved.status });
    return saved;
  }

  async softDeletePost(postUuid: string, reason = ''): Promise<ContentRecord> {
    const { data, error } = await this.client.rpc('instaops_soft_delete_post', {
      p_post_uuid: postUuid,
      p_reason: reason,
    });
    if (error || !data) {
      throw new AppError('POST_LOCKED', error?.message || 'Unable to soft-delete post.', { httpStatus: 409 });
    }
    return rowToContentRecord(data as Record<string, unknown>);
  }

  async markAssetsDeleted(postUuid: string, internalAssetIds: string[], postNextStatus?: string): Promise<void> {
    const now = new Date().toISOString();
    if (internalAssetIds.length > 0) {
      await this.client
        .from('instaops_media_assets')
        .update({
          storage_status: 'DELETED',
          deleted_at: now,
          permanently_deleted_at: now,
        })
        .in('internal_asset_id', internalAssetIds);
    }

    if (postNextStatus) {
      const { data } = await this.client
        .from('instaops_posts')
        .update({
          media_url: '',
          media_count: 0,
          image_count: 0,
          video_count: 0,
          status: postNextStatus,
          approved_revision: null,
          sheets_sync_status: 'PENDING',
        })
        .eq('id', postUuid)
        .select('*')
        .single();

      if (data) {
        const rec = rowToContentRecord(data as Record<string, unknown>);
        await this.enqueueSyncEvent({
          entityType: 'POST',
          entityUuid: postUuid,
          externalId: rec.post_id,
          operation: 'DELETE_MEDIA',
          payload: { row: toSafeSheetRow(rec), post_uuid: postUuid, deleted_assets: internalAssetIds },
          idempotencyKey: `delmedia:${postUuid}:${internalAssetIds.join(',')}:${Date.now()}`,
        });
      }
    } else {
      await this.enqueueSyncEvent({
        entityType: 'MEDIA_ASSET',
        entityUuid: postUuid,
        externalId: internalAssetIds[0] ?? postUuid,
        operation: 'DELETE_MEDIA',
        payload: { post_uuid: postUuid, deleted_assets: internalAssetIds },
        idempotencyKey: `delasset:${postUuid}:${internalAssetIds.join(',')}:${Date.now()}`,
      });
    }
  }

  async enqueueSyncEvent(params: {
    entityType: SyncQueueRecord['entity_type'];
    entityUuid: string;
    externalId: string;
    operation: SyncQueueRecord['operation'];
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<void> {
    await this.client
      .from('instaops_sync_queue')
      .upsert(
        {
          entity_type: params.entityType,
          entity_uuid: params.entityUuid,
          external_id: params.externalId,
          operation: params.operation,
          payload: params.payload,
          idempotency_key: params.idempotencyKey,
          status: 'PENDING',
        },
        { onConflict: 'idempotency_key' },
      );
  }

  async claimSyncBatch(workerId: string, batchSize = 10): Promise<SyncQueueRecord[]> {
    const { data, error } = await this.client.rpc('instaops_claim_sync_batch', {
      p_worker_id: workerId,
      p_batch_size: batchSize,
    });
    if (error || !data) return [];
    return data as SyncQueueRecord[];
  }

  async markSyncSucceeded(syncRow: SyncQueueRecord): Promise<void> {
    const now = new Date().toISOString();
    await this.client
      .from('instaops_sync_queue')
      .update({ status: 'SUCCEEDED', last_error: '', locked_by: null })
      .eq('id', syncRow.id);

    if (syncRow.entity_type === 'POST') {
      await this.client
        .from('instaops_posts')
        .update({ sheets_sync_status: 'SYNCED', sheets_synced_at: now, sheets_sync_error: '' })
        .eq('id', syncRow.entity_uuid);
    }
  }

  async markSyncFailed(syncRow: SyncQueueRecord, errMsg: string): Promise<void> {
    const exhausted = syncRow.attempts >= syncRow.max_attempts;
    const backoffMs = Math.min(3600_000, 30_000 * Math.pow(2, Math.max(0, syncRow.attempts - 1)));
    const nextRetry = new Date(Date.now() + backoffMs).toISOString();

    await this.client
      .from('instaops_sync_queue')
      .update({
        status: exhausted ? 'DEAD_LETTER' : 'FAILED',
        last_error: errMsg.slice(0, 500),
        next_retry_at: nextRetry,
        locked_by: null,
      })
      .eq('id', syncRow.id);

    if (syncRow.entity_type === 'POST') {
      await this.client
        .from('instaops_posts')
        .update({ sheets_sync_status: 'FAILED', sheets_sync_error: errMsg.slice(0, 300) })
        .eq('id', syncRow.entity_uuid);
    }
  }

  private async recordRevision(post: ContentRecord, source: string): Promise<void> {
    if (!post.id) return;
    await this.client
      .from('instaops_post_revisions')
      .upsert(
        {
          post_uuid: post.id,
          revision: Math.max(1, Number(post.revision) || 1),
          caption: post.caption,
          original_caption: post.original_caption,
          change_source: source,
        },
        { onConflict: 'post_uuid,revision' },
      );
  }

  private async auditEvent(
    postUuid: string | null,
    entityType: string,
    entityId: string,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.client.from('instaops_audit_events').insert({
      post_uuid: postUuid,
      entity_type: entityType,
      entity_id: entityId,
      action,
      details,
    });
  }
}

export function isSupabasePrimaryConfigured(): boolean {
  const cfg = getConfig();
  return !cfg.demoMode && Boolean(cfg.supabaseUrl && cfg.supabaseServiceRoleKey);
}
