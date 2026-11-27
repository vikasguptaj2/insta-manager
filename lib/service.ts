import crypto from 'node:crypto';
import type {
  ContentRecord,
  DurableJob,
  ExecutionLogRecord,
  MediaAssetRecord,
  N8nExecutionDetail,
  N8nExecutionSummary,
  OverviewResponse,
  ServiceConnectionStatus,
  StorageSummary,
  SyncQueueRecord,
} from '../types/instaops';
import { getConfig } from './config/env';
import { AppError } from './errors/codes';
import {
  normalizeContentRecord,
  normalizeExecutionLogRecord,
  normalizeMediaAssetRecord,
  toSafeSheetRow,
} from './domain/schema';
import {
  applyContentCreate,
  applyContentPatch,
  assertValidScheduleIso,
  buildReviewSnapshot,
  bumpRevision,
  evaluatePostEligibility,
  extractionCooldown,
  validateCaptionLength,
} from './domain/posts';
import { isPublishedRecord } from './domain/state-machine';
import {
  assertDeletableAssetOwnership,
  assertPostDeletable,
  buildOwnedPublicId,
  summarizeDeletionOutcomes,
} from './cloudinary/assets';
import { checkDownloaderHealth } from './downloader/client';
import {
  getExecutionDetail,
  getWorkflowMetadata,
  isActiveExecution,
  listConfiguredWorkflowExecutions,
  n8nWebhookRequest,
} from './n8n/client';
import { createJobRecord, getLockStore } from './jobs/lock-store';
import { isSupabasePrimaryConfigured, SupabaseRepository } from './supabase/server';
import { getDemoState } from './demo-store';
import type {
  CreatePostInput,
  DeleteConfirmInput,
  ExtractPostInput,
  PatchPostInput,
  PublishPostInput,
  RetryOrReconcileInput,
  SchedulePostInput,
} from './validation/requests';

export interface AcceptedJobResponse {
  ok: true;
  accepted: true;
  request_id: string;
  job_id: string;
  execution_id: string;
  post_id: string;
  status: 'QUEUED';
}

function hashPayload(obj: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function computeStats(
  posts: ContentRecord[],
  assets: MediaAssetRecord[],
  logs: ExecutionLogRecord[],
  jobs: DurableJob[],
  executions: N8nExecutionSummary[],
  syncQueue: SyncQueueRecord[] = [],
): OverviewResponse['stats'] {
  const visible = posts.filter((p) => p.status !== 'DELETED' && !p.deleted_at);
  const activeAssets = assets.filter((a) => a.storage_status === 'ACTIVE');
  const extractLogs = logs.filter((l) => l.operation === 'EXTRACT' && ['COMPLETED', 'FAILED', 'success', 'error'].includes(l.status));
  const extractOk = extractLogs.filter((l) => l.status === 'COMPLETED' || l.status === 'success').length;

  const publishedCount = visible.filter((p) => p.status === 'PUBLISHED').length;
  const failedPublish = visible.filter(
    (p) => p.status === 'VERIFY_MANUALLY' || (p.status === 'FAILED' && /PUBLISH|INSTAGRAM/i.test(p.error_code)),
  ).length;
  const pubTotal = publishedCount + failedPublish;

  return {
    totalPosts: visible.length,
    drafts: visible.filter((p) => p.status === 'DRAFT').length,
    ready: visible.filter((p) => p.status === 'READY').length,
    scheduled: visible.filter((p) => p.status === 'SCHEDULED').length,
    published: publishedCount,
    failed: visible.filter((p) => p.status === 'FAILED').length,
    verifyManually: visible.filter((p) => p.status === 'VERIFY_MANUALLY').length,
    activeJobs:
      executions.filter((e) => !e.finished).length ||
      jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').length,
    mediaAssetsCount: activeAssets.length,
    syncPendingCount: syncQueue.filter((s) => ['PENDING', 'FAILED', 'PROCESSING'].includes(s.status)).length,
    publishSuccessRate: pubTotal > 0 ? Math.round((publishedCount / pubTotal) * 100) : null,
    extractSuccessRate: extractLogs.length > 0 ? Math.round((extractOk / extractLogs.length) * 100) : null,
  };
}

/** Flush queued Supabase -> Google Sheets synchronization jobs cleanly by permanent UUID without risking primary state. */
export async function flushSyncQueueToSheets(
  fetchImpl: typeof fetch = fetch,
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const cfg = getConfig();
  if (cfg.demoMode || !cfg.sheetsSyncEnabled || !isSupabasePrimaryConfigured() || !cfg.n8nWebhookSecret) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  const repo = new SupabaseRepository(fetchImpl);
  const batch = await repo.claimSyncBatch(`bff-${crypto.randomUUID().slice(0, 8)}`, 10);
  let succeeded = 0;
  let failed = 0;

  for (const item of batch) {
    try {
      await n8nWebhookRequest(
        cfg.workflows.contentPath,
        {
          action: 'SYNC_RECORD',
          sync_id: item.id,
          entity_type: item.entity_type,
          entity_uuid: item.entity_uuid,
          external_id: item.external_id,
          operation: item.operation,
          payload: item.payload,
          request_id: crypto.randomUUID(),
        },
        20_000,
        fetchImpl,
      );
      await repo.markSyncSucceeded(item);
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Google Sheets sync failed';
      await repo.markSyncFailed(item, msg);
      failed++;
    }
  }

  return { processed: batch.length, succeeded, failed };
}

export async function getSyncStatusAndFlush(
  mode: 'LIST' | 'FLUSH',
  fetchImpl: typeof fetch = fetch,
): Promise<{
  queue: SyncQueueRecord[];
  flushed?: { processed: number; succeeded: number; failed: number };
}> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    return { queue: [], flushed: mode === 'FLUSH' ? { processed: 0, succeeded: 0, failed: 0 } : undefined };
  }
  if (!isSupabasePrimaryConfigured()) {
    return { queue: [], flushed: mode === 'FLUSH' ? { processed: 0, succeeded: 0, failed: 0 } : undefined };
  }
  const flushed = mode === 'FLUSH' ? await flushSyncQueueToSheets(fetchImpl) : undefined;
  const repo = new SupabaseRepository(fetchImpl);
  const queue = await repo.listSyncQueue(50);
  return { queue, flushed };
}

async function loadRemoteSnapshot(
  fetchImpl: typeof fetch = fetch,
): Promise<{
  posts: ContentRecord[];
  assets: MediaAssetRecord[];
  logs: ExecutionLogRecord[];
  syncQueue: SyncQueueRecord[];
  storage: StorageSummary;
}> {
  const cfg = getConfig();

  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const [posts, assets, logs, syncQueue, cldUsage] = await Promise.all([
      repo.listPosts(false),
      repo.listMediaAssets(),
      repo.listExecutionLogs(100),
      repo.listSyncQueue(50),
      cfg.workflows.contentPath && cfg.n8nWebhookSecret
        ? n8nWebhookRequest<{ ok: true; storage?: StorageSummary['cloudinaryUsage'] }>(
            cfg.workflows.contentPath,
            { action: 'LIST_MEDIA', includeStorage: true, request_id: crypto.randomUUID() },
            15_000,
            fetchImpl,
          )
            .then((r) => r.storage ?? null)
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const active = assets.filter((a) => a.storage_status === 'ACTIVE');
    return {
      posts,
      assets,
      logs,
      syncQueue,
      storage: {
        configured: true,
        cloudName: cfg.cloudinaryCloudName,
        totalAssets: assets.length,
        activeAssets: active.length,
        deletedAssets: assets.filter((a) => a.storage_status === 'DELETED').length,
        unmanagedAssets: assets.filter((a) => a.storage_status === 'UNMANAGED').length,
        totalTrackedBytes: active.reduce((s, a) => s + a.file_size_bytes, 0),
        cloudinaryUsage: cldUsage,
      },
    };
  }

  if (!cfg.workflows.contentPath || !cfg.n8nWebhookSecret) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Configure SUPABASE_SERVICE_ROLE_KEY or online n8n content webhook and secret in .env.local.',
      { httpStatus: 500 },
    );
  }

  const [postsRes, mediaRes] = await Promise.all([
    n8nWebhookRequest<{ ok: true; rows?: unknown[]; logs?: unknown[] }>(
      cfg.workflows.contentPath,
      { action: 'LIST_POSTS', request_id: crypto.randomUUID() },
      30_000,
      fetchImpl,
    ),
    n8nWebhookRequest<{
      ok: true;
      assets?: unknown[];
      storage?: StorageSummary['cloudinaryUsage'];
    }>(
      cfg.workflows.contentPath,
      { action: 'LIST_MEDIA', includeStorage: true, request_id: crypto.randomUUID() },
      30_000,
      fetchImpl,
    ),
  ]);

  const posts = (postsRes.rows ?? []).map((r) => normalizeContentRecord(r as Record<string, unknown>));
  const assets = (mediaRes.assets ?? []).map((a) =>
    normalizeMediaAssetRecord(a as Record<string, unknown>),
  );
  const logs = (postsRes.logs ?? []).map((l) =>
    normalizeExecutionLogRecord(l as Record<string, unknown>),
  );

  const active = assets.filter((a) => a.storage_status === 'ACTIVE');
  return {
    posts,
    assets,
    logs,
    syncQueue: [],
    storage: {
      configured: true,
      cloudName: cfg.cloudinaryCloudName,
      totalAssets: assets.length,
      activeAssets: active.length,
      deletedAssets: assets.filter((a) => a.storage_status === 'DELETED').length,
      unmanagedAssets: assets.filter((a) => a.storage_status === 'UNMANAGED').length,
      totalTrackedBytes: active.reduce((s, a) => s + a.file_size_bytes, 0),
      cloudinaryUsage: mediaRes.storage ?? null,
    },
  };
}

export async function getConnectionsHealth(
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceConnectionStatus[]> {
  const cfg = getConfig();
  const now = new Date().toISOString();

  if (cfg.demoMode) {
    return [
      { id: 'supabase', name: 'Supabase PostgreSQL (Primary)', status: 'connected', detail: 'DEMO_MODE simulated primary DB', checkedAt: now },
      { id: 'n8n', name: 'Online n8n Server', status: 'connected', detail: 'DEMO_MODE simulated', checkedAt: now },
      { id: 'downloader', name: 'Hosted Downloader', status: 'connected', detail: 'DEMO_MODE simulated', checkedAt: now },
      { id: 'sheets', name: 'Google Sheets (Sync Layer)', status: 'connected', detail: 'DEMO_MODE outbox simulated', checkedAt: now },
      { id: 'cloudinary', name: `Cloudinary (${cfg.cloudinaryCloudName})`, status: 'connected', detail: 'DEMO_MODE simulated', checkedAt: now },
      { id: 'instagram', name: `Instagram (${cfg.instagramAccountLabel})`, status: 'connected', detail: `ID ${cfg.instagramUserId} (Demo)`, checkedAt: now },
      { id: 'lockStore', name: 'Durable Lock Store', status: 'connected', detail: 'In-memory test lock', checkedAt: now },
      { id: 'ai', name: 'Optional AI Captioning', status: cfg.flags.aiCaptionEnabled ? 'connected' : 'unconfigured', detail: cfg.flags.aiCaptionEnabled ? 'Enabled' : 'Disabled by config', checkedAt: now },
    ];
  }

  const [sbHealth, dlHealth, wfCheck] = await Promise.all([
    cfg.supabaseUrl && cfg.supabaseServiceRoleKey
      ? new SupabaseRepository(fetchImpl).checkHealth()
      : Promise.resolve({ ok: false, detail: 'Missing SUPABASE_SERVICE_ROLE_KEY in .env.local', latencyMs: 0 }),
    checkDownloaderHealth(fetchImpl, 8_000),
    cfg.n8nApiKey && cfg.workflows.contentId
      ? getWorkflowMetadata(cfg.workflows.contentId, fetchImpl)
          .then((w) => ({ ok: true, active: w.active, name: w.name }))
          .catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve({ ok: false, error: 'Missing N8N_API_KEY or N8N_CONTENT_WORKFLOW_ID' }),
  ]);

  let remoteRecovery: Record<string, { ok?: boolean; detail?: string }> | null = null;
  if (cfg.n8nWebhookSecret && cfg.workflows.recoveryPath) {
    try {
      const r = await n8nWebhookRequest<{ services?: Record<string, { ok?: boolean; detail?: string }> }>(
        cfg.workflows.recoveryPath,
        { action: 'CHECK_CONNECTIONS', request_id: crypto.randomUUID() },
        15_000,
        fetchImpl,
      );
      remoteRecovery = r.services ?? null;
    } catch {
      remoteRecovery = null;
    }
  }

  const lockStore = getLockStore();
  let lockOk = false;
  let lockDetail = 'Local fallback only (Supabase/Postgres lock backend missing; live publish/delete gated)';
  if (lockStore.mode === 'supabase' || lockStore.mode === 'postgres') {
    try {
      await lockStore.ensureSchema();
      lockOk = true;
      lockDetail =
        lockStore.mode === 'supabase'
          ? 'Supabase transactional RPC locking ready'
          : 'PostgreSQL atomic instaops_v2 schema ready';
    } catch (e) {
      lockDetail = `Lock store verification failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const statuses: ServiceConnectionStatus[] = [
    {
      id: 'supabase',
      name: 'Supabase PostgreSQL (Primary)',
      status: !cfg.supabaseServiceRoleKey ? 'unconfigured' : sbHealth.ok ? 'connected' : 'offline',
      detail: sbHealth.detail,
      checkedAt: now,
      latencyMs: sbHealth.latencyMs,
    },
    {
      id: 'n8n',
      name: `Online n8n (${cfg.n8nBaseUrl})`,
      status: wfCheck.ok ? ('active' in wfCheck && wfCheck.active ? 'connected' : 'degraded') : 'offline',
      detail: wfCheck.ok
        ? 'active' in wfCheck && wfCheck.active
          ? `Content workflow active (${wfCheck.name})`
          : 'Workflow imported but inactive in n8n'
        : 'error' in wfCheck
          ? String(wfCheck.error)
          : 'Unreachable',
      checkedAt: now,
    },
    {
      id: 'downloader',
      name: `Hosted Downloader (${cfg.downloaderBaseUrl})`,
      status: dlHealth.ok ? 'connected' : 'offline',
      detail: dlHealth.detail,
      checkedAt: now,
      latencyMs: dlHealth.latencyMs,
    },
    {
      id: 'sheets',
      name: 'Google Sheets (Sync Reporting)',
      status: remoteRecovery?.sheets?.ok ? 'connected' : cfg.sheetsSyncEnabled ? 'degraded' : 'unconfigured',
      detail:
        remoteRecovery?.sheets?.detail ??
        (cfg.sheetsSyncEnabled ? 'Outbox sync enabled via W04/W05' : 'Sheets reporting sync disabled'),
      checkedAt: now,
    },
    {
      id: 'cloudinary',
      name: `Cloudinary (${cfg.cloudinaryCloudName})`,
      status: remoteRecovery?.cloudinary?.ok ? 'connected' : 'unconfigured',
      detail: remoteRecovery?.cloudinary?.detail ?? 'Verified via W04/W05 Cloudinary credential inside online n8n',
      checkedAt: now,
    },
    {
      id: 'instagram',
      name: `Instagram (${cfg.instagramAccountLabel})`,
      status: remoteRecovery?.instagram?.ok ? 'connected' : 'unconfigured',
      detail: remoteRecovery?.instagram?.detail ?? `Target IG User ${cfg.instagramUserId} (v22.0)`,
      checkedAt: now,
    },
    {
      id: 'lockStore',
      name: 'Durable Atomic Lock Store',
      status: lockStore.mode === 'supabase' || lockStore.mode === 'postgres' ? (lockOk ? 'connected' : 'offline') : 'unconfigured',
      detail: lockDetail,
      checkedAt: now,
    },
    {
      id: 'ai',
      name: 'Optional AI Captioning',
      status: cfg.flags.aiCaptionEnabled ? 'connected' : 'unconfigured',
      detail: cfg.flags.aiCaptionEnabled ? 'Enabled' : 'Disabled (AI_CAPTION_ENABLED=false)',
      checkedAt: now,
    },
  ];

  return statuses;
}

export async function getOverviewData(fetchImpl: typeof fetch = fetch): Promise<OverviewResponse> {
  const cfg = getConfig();
  const lockStore = getLockStore();
  const now = new Date().toISOString();

  if (cfg.demoMode) {
    const demo = getDemoState();
    const [jobs, locks, connections] = await Promise.all([
      lockStore.listJobs(50),
      lockStore.listActiveLocks(),
      getConnectionsHealth(fetchImpl),
    ]);
    const activeAssets = demo.assets.filter((a) => a.storage_status === 'ACTIVE');
    const dueScheduled = demo.posts
      .filter((p) => p.status === 'SCHEDULED' && p.publish_at)
      .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at));

    return {
      demo: true,
      accountLabel: cfg.instagramAccountLabel,
      igUserId: cfg.instagramUserId,
      timezone: cfg.timezone,
      cloudName: cfg.cloudinaryCloudName,
      sheetId: cfg.googleSheetId,
      sheetGid: cfg.googleSheetGid,
      flags: {
        schedulingEnabled: demo.schedulingEnabled,
        bulkPublishEnabled: cfg.flags.bulkPublishEnabled,
        aiCaptionEnabled: cfg.flags.aiCaptionEnabled,
        livePublishEnabled: cfg.flags.livePublishEnabled,
        liveDeleteEnabled: cfg.flags.liveDeleteEnabled,
      },
      stats: computeStats(demo.posts, demo.assets, demo.logs, jobs, demo.executions),
      nextScheduledPost: dueScheduled[0] ?? null,
      lastExtractionAt:
        demo.posts
          .map((p) => p.extracted_at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      lastPublicationAt:
        demo.posts
          .map((p) => p.published_at)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
      connections,
      storage: {
        configured: true,
        cloudName: cfg.cloudinaryCloudName,
        totalAssets: demo.assets.length,
        activeAssets: activeAssets.length,
        deletedAssets: demo.assets.filter((a) => a.storage_status === 'DELETED').length,
        unmanagedAssets: demo.assets.filter((a) => a.storage_status === 'UNMANAGED').length,
        totalTrackedBytes: activeAssets.reduce((s, a) => s + a.file_size_bytes, 0),
        cloudinaryUsage: {
          storageBytesUsed: activeAssets.reduce((s, a) => s + a.file_size_bytes, 0),
          bandwidthBytesUsed: null,
          creditsUsagePercent: null,
          resourcesCount: activeAssets.length,
          plan: 'Demo Sandbox',
        },
      },
      posts: demo.posts,
      assets: demo.assets,
      executions: demo.executions,
      logs: demo.logs,
      jobs,
      locks,
      syncQueue: [],
      cooldown: extractionCooldown(demo.posts),
      now,
    };
  }

  const [snapshotRes, execsRes, jobs, locks, connections] = await Promise.all([
    loadRemoteSnapshot(fetchImpl).catch(() => ({
      posts: [] as ContentRecord[],
      assets: [] as MediaAssetRecord[],
      logs: [] as ExecutionLogRecord[],
      syncQueue: [] as SyncQueueRecord[],
      storage: {
        configured: false,
        cloudName: cfg.cloudinaryCloudName,
        totalAssets: 0,
        activeAssets: 0,
        deletedAssets: 0,
        unmanagedAssets: 0,
        totalTrackedBytes: 0,
        cloudinaryUsage: null,
      } satisfies StorageSummary,
    })),
    listConfiguredWorkflowExecutions(25, fetchImpl).catch(() => [] as N8nExecutionSummary[]),
    lockStore.listJobs(50).catch(() => [] as DurableJob[]),
    lockStore.listActiveLocks().catch(() => [] as Awaited<ReturnType<typeof lockStore.listActiveLocks>>),
    getConnectionsHealth(fetchImpl),
  ]);

  const dueScheduled = snapshotRes.posts
    .filter((p) => p.status === 'SCHEDULED' && p.publish_at)
    .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at));

  return {
    demo: false,
    accountLabel: cfg.instagramAccountLabel,
    igUserId: cfg.instagramUserId,
    timezone: cfg.timezone,
    cloudName: cfg.cloudinaryCloudName,
    sheetId: cfg.googleSheetId,
    sheetGid: cfg.googleSheetGid,
    flags: {
      schedulingEnabled: cfg.flags.schedulingEnabled,
      bulkPublishEnabled: cfg.flags.bulkPublishEnabled,
      aiCaptionEnabled: cfg.flags.aiCaptionEnabled,
      livePublishEnabled: cfg.flags.livePublishEnabled,
      liveDeleteEnabled: cfg.flags.liveDeleteEnabled,
    },
    stats: computeStats(
      snapshotRes.posts,
      snapshotRes.assets,
      snapshotRes.logs,
      jobs,
      execsRes,
      snapshotRes.syncQueue,
    ),
    nextScheduledPost: dueScheduled[0] ?? null,
    lastExtractionAt:
      snapshotRes.posts
        .map((p) => p.extracted_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
    lastPublicationAt:
      snapshotRes.posts
        .map((p) => p.published_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
    connections,
    storage: snapshotRes.storage,
    posts: snapshotRes.posts,
    assets: snapshotRes.assets,
    executions: execsRes,
    logs: snapshotRes.logs,
    jobs,
    locks,
    syncQueue: snapshotRes.syncQueue,
    cooldown: extractionCooldown(snapshotRes.posts),
    now,
  };
}

export async function listPostsData(fetchImpl: typeof fetch = fetch): Promise<{
  posts: ContentRecord[];
  assets: MediaAssetRecord[];
}> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const demo = getDemoState();
    return { posts: demo.posts, assets: demo.assets };
  }
  const snap = await loadRemoteSnapshot(fetchImpl);
  return { posts: snap.posts, assets: snap.assets };
}

export async function getPostDetail(
  postId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  post: ContentRecord;
  assets: MediaAssetRecord[];
  logs: ExecutionLogRecord[];
  eligibility: ReturnType<typeof evaluatePostEligibility>;
}> {
  const ov = await getOverviewData(fetchImpl);
  const post = ov.posts.find((p) => p.post_id === postId || p.id === postId);
  if (!post) {
    throw new AppError('POST_NOT_FOUND', `Content record ${postId} was not found.`, { httpStatus: 404 });
  }
  const assets = ov.assets.filter((a) => a.post_id === post.post_id || (post.id && a.post_uuid === post.id));
  const logs = ov.logs.filter((l) => l.post_id === post.post_id);
  const canWrite = ov.demo || ov.connections.some((c) => c.id === 'n8n' && c.status !== 'offline');
  const eligibility = evaluatePostEligibility(post, {
    rows: ov.posts,
    assets: ov.assets,
    executions: ov.executions,
    canWrite,
    schedulingEnabled: ov.flags.schedulingEnabled,
    livePublishEnabled: ov.flags.livePublishEnabled,
    liveDeleteEnabled: ov.flags.liveDeleteEnabled,
    demoMode: ov.demo,
    cooldown: ov.cooldown,
  });
  return { post, assets, logs, eligibility };
}

export async function createPostRecord(
  input: CreatePostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ContentRecord> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const demo = getDemoState();
    const record = applyContentCreate(input, demo.posts);
    demo.posts = [record, ...demo.posts];
    return record;
  }

  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const existingPosts = await repo.listPosts(false);
    const record = applyContentCreate(input, existingPosts);
    const saved = await repo.createPost(record);
    void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    return saved;
  }

  const snap = await loadRemoteSnapshot(fetchImpl);
  const record = applyContentCreate(input, snap.posts);
  const res = await n8nWebhookRequest<{ ok: true; row: Record<string, unknown> }>(
    cfg.workflows.contentPath,
    { action: 'CREATE_POST', request_id: crypto.randomUUID(), record: toSafeSheetRow(record) },
    35_000,
    fetchImpl,
  );
  return normalizeContentRecord(res.row ?? record);
}

export async function updatePostRecord(
  postId: string,
  patch: PatchPostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ContentRecord> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const demo = getDemoState();
    const existing = demo.posts.find((p) => p.post_id === postId || p.id === postId);
    if (!existing) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    const updated = applyContentPatch(existing, patch, demo.posts);
    demo.posts = demo.posts.map((p) => (p.post_id === existing.post_id ? updated : p));
    return updated;
  }

  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const allPosts = await repo.listPosts(false);
    const existing = allPosts.find((p) => p.post_id === postId || p.id === postId);
    if (!existing) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    const updated = applyContentPatch(existing, patch, allPosts);
    const saved = await repo.updatePost(updated, 'CAPTION_EDIT');
    void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    return saved;
  }

  const snap = await loadRemoteSnapshot(fetchImpl);
  const existing = snap.posts.find((p) => p.post_id === postId);
  if (!existing) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
  const updated = applyContentPatch(existing, patch, snap.posts);
  const res = await n8nWebhookRequest<{ ok: true; row: Record<string, unknown> }>(
    cfg.workflows.contentPath,
    {
      action: 'UPDATE_POST',
      request_id: crypto.randomUUID(),
      post_id: postId,
      expected_revision: existing.revision,
      record: toSafeSheetRow(updated),
    },
    35_000,
    fetchImpl,
  );
  return normalizeContentRecord(res.row ?? updated);
}

/** First click: Extract media & metadata from hosted downloader -> upload to Cloudinary -> stop without publishing. */
export async function triggerExtractPost(
  postId: string,
  input: ExtractPostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AcceptedJobResponse> {
  const cfg = getConfig();
  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const ownerId = `api:${requestId}`;
  const idemKey = input.idempotencyKey ?? `extract:${postId}:${requestId}`;

  await lockStore.claimIdempotency(idemKey, hashPayload({ postId, op: 'EXTRACT' }));
  await lockStore.acquireLock({
    lock_key: `post:${postId}`,
    post_id: postId,
    operation: 'EXTRACT',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 600,
  });

  try {
    const ov = await getOverviewData(fetchImpl);
    const post = ov.posts.find((p) => p.post_id === postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });

    const elig = evaluatePostEligibility(post, {
      rows: ov.posts,
      assets: ov.assets,
      executions: ov.executions,
      canWrite: true,
      schedulingEnabled: ov.flags.schedulingEnabled,
      livePublishEnabled: ov.flags.livePublishEnabled,
      liveDeleteEnabled: ov.flags.liveDeleteEnabled,
      demoMode: ov.demo,
      cooldown: ov.cooldown,
    });

    if (!elig.extract.enabled) {
      throw new AppError(
        ov.cooldown.blocked ? 'UPSTREAM_RATE_LIMIT' : elig.isDuplicateSource ? 'DUPLICATE_SOURCE' : 'POST_LOCKED',
        elig.extract.reason,
        { httpStatus: ov.cooldown.blocked ? 429 : 409 },
      );
    }

    if (cfg.demoMode) {
      const demo = getDemoState();
      const now = new Date().toISOString();
      const fakeUrl = `https://res.cloudinary.com/${cfg.cloudinaryCloudName}/video/upload/v1795709999/${buildOwnedPublicId(postId, 0, post.source_id)}.mp4`;
      const asset: MediaAssetRecord = {
        internal_asset_id: `ast_${postId}_0`,
        post_id: postId,
        media_index: 0,
        media_type: post.media_type === 'IMAGE' ? 'IMAGE' : 'VIDEO',
        source_expires_at: '',
        cloudinary_public_id: buildOwnedPublicId(postId, 0, post.source_id),
        cloudinary_asset_id: `cld_demo_${postId}`,
        secure_url: fakeUrl,
        thumbnail_url: fakeUrl,
        resource_type: post.media_type === 'IMAGE' ? 'image' : 'video',
        delivery_type: 'upload',
        format: post.media_type === 'IMAGE' ? 'jpg' : 'mp4',
        file_size_bytes: 6_420_100,
        width: 1080,
        height: 1920,
        duration: 21.5,
        storage_status: 'ACTIVE',
        created_at: now,
        updated_at: now,
        deleted_at: '',
        error: '',
      };
      const updated: ContentRecord = {
        ...post,
        media_url: fakeUrl,
        original_caption: post.original_caption || 'Extracted sample caption from Demo Downloader (never auto-published).',
        caption_status: 'available',
        caption_source: 'structured',
        status: 'DRAFT',
        media_count: '1',
        video_count: post.media_type === 'IMAGE' ? '0' : '1',
        image_count: post.media_type === 'IMAGE' ? '1' : '0',
        file_size_bytes: '6420100',
        extracted_at: now,
        uploaded_at: now,
        updated_at: now,
        revision: bumpRevision(post.revision),
        approved_revision: '',
      };
      demo.posts = demo.posts.map((p) => (p.post_id === postId ? updated : p));
      demo.assets = [asset, ...demo.assets.filter((a) => a.post_id !== postId)];
      const execId = `demo-ext-${Date.now()}`;
      demo.executions.unshift({
        id: execId,
        workflowId: 'demo-w01',
        workflowName: 'W01 Extract & Upload (Demo)',
        postId,
        operation: 'EXTRACT',
        status: 'success',
        mode: 'webhook',
        startedAt: now,
        stoppedAt: now,
        finished: true,
        durationMs: 1200,
      });
      await lockStore.saveJob({
        ...createJobRecord({ job_id: jobId, request_id: requestId, execution_id: execId, post_id: postId, operation: 'EXTRACT' }),
        stage: 'COMPLETED',
        status: 'COMPLETED',
        finished_at: now,
      });
      await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', { ok: true, execution_id: execId });
      await lockStore.releaseLock(`post:${postId}`, ownerId);
      return { ok: true, accepted: true, request_id: requestId, job_id: jobId, execution_id: execId, post_id: postId, status: 'QUEUED' };
    }

    if (!cfg.workflows.extractId) {
      throw new AppError('CONFIGURATION_ERROR', 'N8N_EXTRACT_WORKFLOW_ID is not configured.', { httpStatus: 500 });
    }
    const wf = await getWorkflowMetadata(cfg.workflows.extractId, fetchImpl);
    if (!wf.active) {
      throw new AppError('CONFIGURATION_ERROR', 'W01 Extract & Upload workflow is inactive in n8n.', { httpStatus: 409 });
    }

    const hookRes = await n8nWebhookRequest<{ accepted?: boolean; execution_id?: string }>(
      cfg.workflows.extractPath,
      {
        action: 'EXTRACT',
        post_uuid: post.id ?? '',
        post_id: post.post_id,
        source_instagram_url: post.source_instagram_url,
        expected_revision: post.revision,
        request_id: requestId,
        job_id: jobId,
        lock_owner: ownerId,
        authorized: true,
      },
      35_000,
      fetchImpl,
    );

    if (hookRes.accepted !== true || !hookRes.execution_id) {
      throw new AppError('CONFIGURATION_ERROR', 'Online n8n W01 did not return accepted execution acknowledgement.', {
        httpStatus: 502,
      });
    }

    const execId = String(hookRes.execution_id);
    await lockStore.saveJob({
      ...createJobRecord({
        job_id: jobId,
        request_id: requestId,
        execution_id: execId,
        post_id: postId,
        operation: 'EXTRACT',
        stage: 'FETCHING_SOURCE',
      }),
      status: 'RUNNING',
    });
    const out: AcceptedJobResponse = {
      ok: true,
      accepted: true,
      request_id: requestId,
      job_id: jobId,
      execution_id: execId,
      post_id: postId,
      status: 'QUEUED',
    };
    await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', out);
    return out;
  } catch (err) {
    await lockStore.releaseLock(`post:${postId}`, ownerId);
    throw err;
  }
}

/** Second click: Publish only the selected reviewed Reel/Image with explicit atomic lock & revision binding. */
export async function triggerPublishPost(
  postId: string,
  input: PublishPostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<AcceptedJobResponse> {
  const cfg = getConfig();
  const hasDurableCoord =
    (cfg.atomicLockProvider === 'supabase' && Boolean(cfg.supabaseUrl && cfg.supabaseServiceRoleKey)) ||
    (cfg.atomicLockProvider === 'postgres' && Boolean(cfg.databaseUrl));

  if (!cfg.demoMode && !hasDurableCoord) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Remote live publishing requires durable Supabase (SUPABASE_SERVICE_ROLE_KEY) or Postgres (DATABASE_URL) atomic locking.',
      { httpStatus: 409 },
    );
  }
  if (!cfg.demoMode && !cfg.flags.livePublishEnabled) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Live publishing is safely disabled until LIVE_PUBLISH_ENABLED=true.',
      { httpStatus: 409 },
    );
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const ownerId = `pub:${requestId}`;
  const idemKey = input.idempotencyKey ?? `publish:${postId}:${input.reviewedRevision}`;

  const claim = await lockStore.claimIdempotency<AcceptedJobResponse>(
    idemKey,
    hashPayload({ postId, rev: input.reviewedRevision, op: 'PUBLISH' }),
  );
  if (!claim.claimed) {
    throw new AppError(
      'POST_LOCKED',
      `Duplicate publish request rejected for ${postId} revision ${input.reviewedRevision} (${claim.existingState ?? 'IN_PROGRESS'}).`,
      { httpStatus: 409 },
    );
  }

  await lockStore.acquireLock({
    lock_key: `post:${postId}`,
    post_id: postId,
    operation: 'PUBLISH',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 600,
  });

  try {
    let ov = await getOverviewData(fetchImpl);
    let post = ov.posts.find((p) => p.post_id === postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });

    if (post.revision !== input.reviewedRevision) {
      throw new AppError(
        'REVISION_CONFLICT',
        `Content changed since review (expected rev ${input.reviewedRevision}, actual ${post.revision}). Refresh and review again.`,
        { httpStatus: 409 },
      );
    }

    if (input.caption !== undefined && input.caption !== post.caption) {
      validateCaptionLength(input.caption, {
        allowEmpty: input.allowEmptyCaption === true || Boolean(post.original_caption.trim()),
      });
      post = await updatePostRecord(
        postId,
        { caption: input.caption, allowEmptyCaption: input.allowEmptyCaption },
        fetchImpl,
      );
      ov = await getOverviewData(fetchImpl);
      post = ov.posts.find((p) => p.post_id === postId) ?? post;
    }

    const elig = evaluatePostEligibility(post, {
      rows: ov.posts,
      assets: ov.assets,
      executions: ov.executions,
      canWrite: true,
      schedulingEnabled: ov.flags.schedulingEnabled,
      livePublishEnabled: ov.flags.livePublishEnabled,
      liveDeleteEnabled: ov.flags.liveDeleteEnabled,
      demoMode: ov.demo,
      cooldown: ov.cooldown,
    });

    if (!elig.publish.enabled) {
      throw new AppError(
        elig.isCarousel ? 'INVALID_MEDIA_TYPE' : 'POST_LOCKED',
        elig.publish.reason,
        { httpStatus: elig.isCarousel ? 422 : 409 },
      );
    }

    const postAssets = ov.assets
      .filter((a) => (a.post_id === post.post_id || (post.id && a.post_uuid === post.id)) && a.storage_status === 'ACTIVE')
      .sort((a, b) => a.media_index - b.media_index);
    const mediaItems = postAssets.map((a) => ({
      asset_uuid: a.id ?? '',
      internal_asset_id: a.internal_asset_id,
      media_index: a.media_index,
      resource_type: a.resource_type,
      media_type: a.media_type,
      secure_url: a.secure_url,
    }));

    const reviewedSnapshot = buildReviewSnapshot(post);

    if (cfg.demoMode) {
      const demo = getDemoState();
      const now = new Date().toISOString();
      const pubId = `180${Date.now().toString().slice(-14)}`;
      const childIds =
        post.media_type === 'CAROUSEL'
          ? mediaItems.map((_, idx) => `1790${Date.now().toString().slice(-8)}${idx}`)
          : [];
      const updated: ContentRecord = {
        ...post,
        status: 'PUBLISHED',
        approved_revision: post.revision,
        published_id: pubId,
        published_url:
          post.media_type === 'REEL'
            ? `https://www.instagram.com/reel/${post.source_id}/`
            : `https://www.instagram.com/p/${post.source_id}/`,
        published_at: now,
        processed_at: now,
        updated_at: now,
        container_id: `cnt_${Date.now()}`,
        child_container_ids: childIds.length ? JSON.stringify(childIds) : undefined,
      };
      demo.posts = demo.posts.map((p) => (p.post_id === post.post_id ? updated : p));
      const execId = `demo-pub-${Date.now()}`;
      demo.executions.unshift({
        id: execId,
        workflowId: 'demo-w02',
        workflowName: 'W02 Publish Content (Demo)',
        postId: post.post_id,
        operation: 'PUBLISH',
        status: 'success',
        mode: 'webhook',
        startedAt: now,
        stoppedAt: now,
        finished: true,
        durationMs: 3200,
      });
      await lockStore.saveJob({
        ...createJobRecord({ job_id: jobId, request_id: requestId, execution_id: execId, post_id: post.post_id, operation: 'PUBLISH' }),
        stage: 'COMPLETED',
        status: 'COMPLETED',
        finished_at: now,
      });
      await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', { ok: true, execution_id: execId });
      await lockStore.releaseLock(`post:${postId}`, ownerId);
      return { ok: true, accepted: true, request_id: requestId, job_id: jobId, execution_id: execId, post_id: post.post_id, status: 'QUEUED' };
    }

    if (!cfg.workflows.publishId) {
      throw new AppError('CONFIGURATION_ERROR', 'N8N_PUBLISH_WORKFLOW_ID is not configured.', { httpStatus: 500 });
    }
    const wf = await getWorkflowMetadata(cfg.workflows.publishId, fetchImpl);
    if (!wf.active) {
      throw new AppError('CONFIGURATION_ERROR', 'W02 Publish Content workflow is inactive in n8n.', { httpStatus: 409 });
    }

    const hookRes = await n8nWebhookRequest<{ accepted?: boolean; execution_id?: string }>(
      cfg.workflows.publishPath,
      {
        action: 'PUBLISH',
        post_uuid: post.id ?? '',
        post_id: post.post_id,
        ig_user_id: cfg.instagramUserId,
        media_type: post.media_type,
        caption: post.caption || post.original_caption,
        media_url: post.media_url,
        media_items: mediaItems,
        reviewed_revision: post.revision,
        review_snapshot: reviewedSnapshot,
        request_id: requestId,
        job_id: jobId,
        lock_owner: ownerId,
        confirm: true,
      },
      35_000,
      fetchImpl,
    );

    if (hookRes.accepted !== true || !hookRes.execution_id) {
      throw new AppError('PUBLISH_OUTCOME_UNKNOWN', 'Online n8n W02 did not confirm execution acceptance; reconcile before retrying.', {
        httpStatus: 502,
      });
    }

    const execId = String(hookRes.execution_id);
    await lockStore.saveJob({
      ...createJobRecord({
        job_id: jobId,
        request_id: requestId,
        execution_id: execId,
        post_id: postId,
        operation: 'PUBLISH',
        stage: 'CREATING_CONTAINER',
      }),
      status: 'RUNNING',
    });

    const out: AcceptedJobResponse = {
      ok: true,
      accepted: true,
      request_id: requestId,
      job_id: jobId,
      execution_id: execId,
      post_id: postId,
      status: 'QUEUED',
    };
    await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', out);
    return out;
  } catch (err) {
    await lockStore.releaseLock(`post:${postId}`, ownerId);
    throw err;
  }
}

export async function schedulePost(
  postId: string,
  input: SchedulePostInput,
  fetchImpl: typeof fetch = fetch,
): Promise<ContentRecord> {
  const cfg = getConfig();
  assertValidScheduleIso(input.publish_at);

  const ov = await getOverviewData(fetchImpl);
  let post = ov.posts.find((p) => p.post_id === postId);
  if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });

  if (post.revision !== input.reviewedRevision) {
    throw new AppError('REVISION_CONFLICT', 'Post revision changed since review. Refresh before scheduling.', {
      httpStatus: 409,
    });
  }

  if (input.caption !== undefined && input.caption !== post.caption) {
    post = await updatePostRecord(postId, { caption: input.caption, allowEmptyCaption: input.allowEmptyCaption }, fetchImpl);
  }

  const elig = evaluatePostEligibility(post, {
    rows: ov.posts,
    assets: ov.assets,
    executions: ov.executions,
    canWrite: true,
    schedulingEnabled: ov.flags.schedulingEnabled,
    livePublishEnabled: ov.flags.livePublishEnabled,
    liveDeleteEnabled: ov.flags.liveDeleteEnabled,
    demoMode: ov.demo,
    cooldown: ov.cooldown,
  });

  if (!elig.schedule.enabled) {
    throw new AppError(elig.isCarousel ? 'INVALID_MEDIA_TYPE' : 'SCHEDULE_CONFLICT', elig.schedule.reason, {
      httpStatus: 409,
    });
  }

  const scheduledUtc = new Date(Date.parse(input.publish_at)).toISOString();

  if (cfg.demoMode) {
    const demo = getDemoState();
    const updated: ContentRecord = {
      ...post,
      publish_mode: 'LATER',
      publish_at: scheduledUtc,
      status: 'SCHEDULED',
      approved_revision: post.revision,
      updated_at: new Date().toISOString(),
    };
    demo.posts = demo.posts.map((p) => (p.post_id === post.post_id ? updated : p));
    return updated;
  }

  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const updated = await repo.updatePost(
      {
        ...post,
        publish_mode: 'LATER',
        publish_at: scheduledUtc,
        status: 'SCHEDULED',
        approved_revision: post.revision,
      },
      'SCHEDULE',
    );
    void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    return updated;
  }

  const res = await n8nWebhookRequest<{ ok: true; row: Record<string, unknown> }>(
    cfg.workflows.contentPath,
    {
      action: 'SCHEDULE_POST',
      post_id: postId,
      publish_at: scheduledUtc,
      expected_revision: post.revision,
      approved_revision: post.revision,
      confirm: true,
      request_id: crypto.randomUUID(),
    },
    35_000,
    fetchImpl,
  );
  return normalizeContentRecord(res.row ?? post);
}

export async function cancelPostSchedule(
  postId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ContentRecord> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const demo = getDemoState();
    const post = demo.posts.find((p) => p.post_id === postId || p.id === postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    if (post.status !== 'SCHEDULED') {
      throw new AppError('SCHEDULE_CONFLICT', `Post ${postId} is not scheduled.`, { httpStatus: 409 });
    }
    const updated: ContentRecord = {
      ...post,
      publish_mode: 'NOW',
      publish_at: '',
      status: 'READY',
      approved_revision: '',
      updated_at: new Date().toISOString(),
    };
    demo.posts = demo.posts.map((p) => (p.post_id === post.post_id ? updated : p));
    return updated;
  }

  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const post = await repo.getPostByIdOrUuid(postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    if (post.status !== 'SCHEDULED') {
      throw new AppError('SCHEDULE_CONFLICT', `Post ${post.post_id} is not scheduled.`, { httpStatus: 409 });
    }
    const updated = await repo.updatePost(
      { ...post, publish_mode: 'NOW', publish_at: '', status: 'READY', approved_revision: '' },
      'CANCEL_SCHEDULE',
    );
    void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    return updated;
  }

  const res = await n8nWebhookRequest<{ ok: true; row: Record<string, unknown> }>(
    cfg.workflows.contentPath,
    { action: 'CANCEL_SCHEDULE', post_id: postId, request_id: crypto.randomUUID() },
    35_000,
    fetchImpl,
  );
  return normalizeContentRecord(res.row);
}

export async function archivePost(
  postId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ContentRecord> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const demo = getDemoState();
    const post = demo.posts.find((p) => p.post_id === postId || p.id === postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    const now = new Date().toISOString();
    const updated: ContentRecord = {
      ...post,
      status: 'ARCHIVED',
      archived_at: now,
      updated_at: now,
      approved_revision: '',
    };
    demo.posts = demo.posts.map((p) => (p.post_id === post.post_id ? updated : p));
    return updated;
  }

  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const post = await repo.getPostByIdOrUuid(postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    const updated = await repo.updatePost(
      { ...post, status: 'ARCHIVED', archived_at: new Date().toISOString(), approved_revision: '' },
      'ARCHIVE',
    );
    void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    return updated;
  }

  const res = await n8nWebhookRequest<{ ok: true; row: Record<string, unknown> }>(
    cfg.workflows.contentPath,
    { action: 'ARCHIVE_POST', post_id: postId, request_id: crypto.randomUUID() },
    35_000,
    fetchImpl,
  );
  return normalizeContentRecord(res.row);
}

/** Option A: Permanently delete Cloudinary assets owned by this post while preserving the post record. */
export async function deletePostMedia(
  postId: string,
  input: DeleteConfirmInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ post_id: string; deletedAssets: string[]; status: string }> {
  const cfg = getConfig();
  const hasDurableCoord =
    (cfg.atomicLockProvider === 'supabase' && Boolean(cfg.supabaseUrl && cfg.supabaseServiceRoleKey)) ||
    Boolean(cfg.databaseUrl);
  if (!input.confirm) throw new AppError('UNAUTHORIZED_CONTENT', 'Confirmation required.', { httpStatus: 403 });
  if (!cfg.demoMode && (!cfg.flags.liveDeleteEnabled || !hasDurableCoord)) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Live Cloudinary deletion is disabled until Supabase/Postgres locking is configured and LIVE_DELETE_ENABLED=true.',
      { httpStatus: 409 },
    );
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const ownerId = `delmedia:${requestId}`;
  await lockStore.acquireLock({
    lock_key: `post:${postId}`,
    post_id: postId,
    operation: 'DELETE_MEDIA',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 300,
  });

  try {
    const ov = await getOverviewData(fetchImpl);
    const post = ov.posts.find((p) => p.post_id === postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });

    const ownedAssets = ov.assets.filter(
      (a) => a.post_id === postId && a.storage_status === 'ACTIVE',
    );
    if (!ownedAssets.length) {
      throw new AppError('MEDIA_UNAVAILABLE', `Post ${postId} has no active managed Cloudinary assets.`, {
        httpStatus: 404,
      });
    }
    for (const asset of ownedAssets) {
      assertDeletableAssetOwnership(asset, post);
    }

    if (cfg.demoMode) {
      const demo = getDemoState();
      const now = new Date().toISOString();
      demo.assets = demo.assets.map((a) =>
        a.post_id === postId && a.storage_status === 'ACTIVE'
          ? { ...a, storage_status: 'DELETED', deleted_at: now, updated_at: now }
          : a,
      );
      const nextStatus = isPublishedRecord(post) ? post.status : 'MEDIA_DELETED';
      demo.posts = demo.posts.map((p) =>
        p.post_id === postId
          ? {
              ...p,
              media_url: '',
              media_count: '0',
              image_count: '0',
              video_count: '0',
              status: nextStatus,
              approved_revision: '',
              revision: bumpRevision(p.revision),
              updated_at: now,
            }
          : p,
      );
      return {
        post_id: postId,
        deletedAssets: ownedAssets.map((a) => a.internal_asset_id),
        status: nextStatus,
      };
    }

    const res = await n8nWebhookRequest<{
      ok: true;
      outcomes: Array<{ internal_asset_id: string; public_id: string; result?: string; error?: string }>;
      status: string;
    }>(
      cfg.workflows.contentPath,
      {
        action: 'DELETE_MEDIA',
        post_uuid: post.id ?? '',
        post_id: post.post_id,
        asset_ids: ownedAssets.map((a) => a.internal_asset_id),
        assets: ownedAssets.map((a) => ({
          internal_asset_id: a.internal_asset_id,
          public_id: a.cloudinary_public_id,
          resource_type: a.resource_type,
        })),
        confirm: true,
        request_id: requestId,
      },
      60_000,
      fetchImpl,
    );

    const summary = summarizeDeletionOutcomes(res.outcomes ?? []);
    if (!summary.allConfirmedGone) {
      throw new AppError(
        'CLOUDINARY_DELETE_FAILED',
        `Partial Cloudinary deletion failure (${summary.failed.length} asset(s) failed). Run Asset Reconciliation in Recovery Center.`,
        { httpStatus: 502, details: { failed: summary.failed } },
      );
    }
    const goneIds = [...summary.succeededIds, ...summary.alreadyMissingIds];
    const nextStatus = isPublishedRecord(post) ? post.status : 'MEDIA_DELETED';
    if (isSupabasePrimaryConfigured() && post.id) {
      await new SupabaseRepository(fetchImpl).markAssetsDeleted(post.id, goneIds, nextStatus);
      void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    }
    return {
      post_id: post.post_id,
      deletedAssets: goneIds,
      status: nextStatus,
    };
  } finally {
    await lockStore.releaseLock(`post:${postId}`, ownerId);
  }
}

/** Delete one single verified MediaAsset record owned by a draft/ready/carousel post. */
export async function deleteSingleMediaAsset(
  internalAssetId: string,
  input: DeleteConfirmInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ internal_asset_id: string; storage_status: string }> {
  const cfg = getConfig();
  const hasDurableCoord =
    (cfg.atomicLockProvider === 'supabase' && Boolean(cfg.supabaseUrl && cfg.supabaseServiceRoleKey)) ||
    Boolean(cfg.databaseUrl);
  if (!input.confirm) throw new AppError('UNAUTHORIZED_CONTENT', 'Confirmation required.', { httpStatus: 403 });
  if (!cfg.demoMode && (!cfg.flags.liveDeleteEnabled || !hasDurableCoord)) {
    throw new AppError('CONFIGURATION_ERROR', 'Live deletion requires LIVE_DELETE_ENABLED=true and Supabase/Postgres locking.', {
      httpStatus: 409,
    });
  }

  const ov = await getOverviewData(fetchImpl);
  const asset = ov.assets.find((a) => a.internal_asset_id === internalAssetId);
  if (!asset) {
    throw new AppError('POST_NOT_FOUND', `Media asset ${internalAssetId} not found in MediaAssets records.`, {
      httpStatus: 404,
    });
  }
  const parent = ov.posts.find((p) => p.post_id === asset.post_id);
  assertDeletableAssetOwnership(asset, parent);

  if (cfg.demoMode) {
    const demo = getDemoState();
    const now = new Date().toISOString();
    demo.assets = demo.assets.map((a) =>
      a.internal_asset_id === internalAssetId
        ? { ...a, storage_status: 'DELETED', deleted_at: now, updated_at: now }
        : a,
    );
    const remaining = demo.assets.filter(
      (a) => a.post_id === asset.post_id && a.storage_status === 'ACTIVE',
    );
    if (parent) {
      demo.posts = demo.posts.map((p) =>
        p.post_id === asset.post_id
          ? {
              ...p,
              media_url: remaining[0]?.secure_url ?? '',
              media_count: String(remaining.length),
              status: remaining.length === 0 && !isPublishedRecord(p) ? 'MEDIA_DELETED' : p.status,
              approved_revision: '',
              updated_at: now,
            }
          : p,
      );
    }
    return { internal_asset_id: internalAssetId, storage_status: 'DELETED' };
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const ownerId = `delasset:${requestId}`;
  await lockStore.acquireLock({
    lock_key: `post:${asset.post_id}`,
    post_id: asset.post_id,
    operation: 'DELETE_MEDIA',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 300,
  });

  try {
    await n8nWebhookRequest(
      cfg.workflows.contentPath,
      {
        action: 'DELETE_MEDIA',
        post_uuid: parent?.id ?? '',
        post_id: asset.post_id,
        asset_ids: [internalAssetId],
        assets: [
          {
            internal_asset_id: asset.internal_asset_id,
            public_id: asset.cloudinary_public_id,
            resource_type: asset.resource_type,
          },
        ],
        confirm: true,
        request_id: requestId,
      },
      60_000,
      fetchImpl,
    );
    if (isSupabasePrimaryConfigured() && parent?.id) {
      await new SupabaseRepository(fetchImpl).markAssetsDeleted(parent.id, [internalAssetId]);
      void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    }
    return { internal_asset_id: internalAssetId, storage_status: 'DELETED' };
  } finally {
    await lockStore.releaseLock(`post:${asset.post_id}`, ownerId);
  }
}

/** Option B: Soft-delete the Supabase/Sheets post record (with optional Cloudinary asset removal). */
export async function deletePostAndMedia(
  postId: string,
  input: DeleteConfirmInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ post_id: string; status: 'DELETED' }> {
  const cfg = getConfig();
  const hasDurableCoord =
    (cfg.atomicLockProvider === 'supabase' && Boolean(cfg.supabaseUrl && cfg.supabaseServiceRoleKey)) ||
    Boolean(cfg.databaseUrl);
  if (!input.confirm) throw new AppError('UNAUTHORIZED_CONTENT', 'Confirmation required.', { httpStatus: 403 });
  if (!cfg.demoMode && (!cfg.flags.liveDeleteEnabled || !hasDurableCoord)) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Live post deletion is disabled until Supabase/Postgres locking is configured and LIVE_DELETE_ENABLED=true.',
      { httpStatus: 409 },
    );
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const ownerId = `delpost:${requestId}`;
  await lockStore.acquireLock({
    lock_key: `post:${postId}`,
    post_id: postId,
    operation: 'DELETE_POST',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 300,
  });

  try {
    const ov = await getOverviewData(fetchImpl);
    const post = ov.posts.find((p) => p.post_id === postId || p.id === postId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
    assertPostDeletable(post, ov.assets);

    if (cfg.demoMode) {
      const demo = getDemoState();
      const now = new Date().toISOString();
      demo.assets = demo.assets.map((a) =>
        a.post_id === post.post_id && a.storage_status === 'ACTIVE'
          ? { ...a, storage_status: 'DELETED', deleted_at: now, updated_at: now }
          : a,
      );
      demo.posts = demo.posts.map((p) =>
        p.post_id === post.post_id
          ? {
              ...p,
              media_url: '',
              media_count: '0',
              status: 'DELETED',
              deleted_at: now,
              updated_at: now,
              approved_revision: '',
            }
          : p,
      );
      return { post_id: post.post_id, status: 'DELETED' };
    }

    if (isSupabasePrimaryConfigured() && post.id) {
      const activeAssets = ov.assets.filter(
        (a) => a.post_id === post.post_id && a.storage_status === 'ACTIVE' && Boolean(a.cloudinary_public_id),
      );
      if (activeAssets.length > 0 && cfg.n8nWebhookSecret) {
        await n8nWebhookRequest(
          cfg.workflows.contentPath,
          {
            action: 'DELETE_MEDIA',
            post_uuid: post.id,
            post_id: post.post_id,
            asset_ids: activeAssets.map((a) => a.internal_asset_id),
            assets: activeAssets.map((a) => ({
              internal_asset_id: a.internal_asset_id,
              public_id: a.cloudinary_public_id,
              resource_type: a.resource_type,
            })),
            confirm: true,
            request_id: requestId,
          },
          60_000,
          fetchImpl,
        );
      }
      const repo = new SupabaseRepository(fetchImpl);
      if (activeAssets.length > 0) {
        await repo.markAssetsDeleted(post.id, activeAssets.map((a) => a.internal_asset_id));
      }
      await repo.softDeletePost(post.id, input.reason ?? '');
      void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
      return { post_id: post.post_id, status: 'DELETED' };
    }

    await n8nWebhookRequest(
      cfg.workflows.contentPath,
      { action: 'DELETE_POST', post_id: post.post_id, confirm: true, reason: input.reason ?? '', request_id: requestId },
      60_000,
      fetchImpl,
    );
    return { post_id: post.post_id, status: 'DELETED' };
  } finally {
    await lockStore.releaseLock(`post:${postId}`, ownerId);
  }
}

export async function retryOrReconcilePost(
  mode: 'RETRY' | 'RECONCILE',
  postId: string,
  input: RetryOrReconcileInput,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const cfg = getConfig();
  const lockStore = getLockStore();
  const ov = await getOverviewData(fetchImpl);
  const post = ov.posts.find((p) => p.post_id === postId);
  if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });

  if (mode === 'RETRY') {
    if (!input.inspected) {
      throw new AppError('UNAUTHORIZED_CONTENT', 'Confirm you inspected the failure before retrying.', {
        httpStatus: 403,
      });
    }
    if (post.status !== 'FAILED') {
      throw new AppError('POST_LOCKED', `Only FAILED records can retry (${post.status}).`, { httpStatus: 409 });
    }
    if (post.error_code === 'UPSTREAM_RATE_LIMIT' && ov.cooldown.blocked) {
      throw new AppError(
        'UPSTREAM_RATE_LIMIT',
        `Rate-limit cooldown active until ${ov.cooldown.until ?? 'unknown'}.`,
        { httpStatus: 429 },
      );
    }
    if (cfg.demoMode) {
      const demo = getDemoState();
      demo.posts = demo.posts.map((p) =>
        p.post_id === postId ? { ...p, status: 'DRAFT', error: '', error_code: '', error_stage: '' } : p,
      );
      return { ok: true, post_id: postId, status: 'DRAFT' };
    }
    if (isSupabasePrimaryConfigured() && post.id) {
      const repo = new SupabaseRepository(fetchImpl);
      const updated = await repo.updatePost(
        {
          ...post,
          status: post.media_url ? 'READY' : 'DRAFT',
          error: '',
          error_code: '',
          error_stage: '',
        },
        'RETRY',
      );
      void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
      return { ok: true, post_id: post.post_id, status: updated.status };
    }
    return n8nWebhookRequest(
      cfg.workflows.recoveryPath,
      { action: 'SAFE_RETRY', post_id: post.post_id, inspected: true, request_id: crypto.randomUUID() },
      35_000,
      fetchImpl,
    );
  }

  // RECONCILE
  if (!input.inspected) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Confirm inspection (inspected: true) before reconciling.', {
      httpStatus: 403,
    });
  }
  if (input.resolution === 'MARK_PUBLISHED' && !(input.published_id ?? '').trim()) {
    throw new AppError('INVALID_MEDIA_TYPE', 'Verified Instagram published_id is required to mark PUBLISHED.', {
      httpStatus: 422,
    });
  }
  if (input.resolution === 'RELEASE_LOCK' && input.forceReleaseLock) {
    const staleReleased = await lockStore.releaseStaleLocks();
    return { ok: true, action: 'RELEASE_STALE_LOCK', released: staleReleased };
  }

  if (cfg.demoMode) {
    const demo = getDemoState();
    const resolution = input.resolution ?? 'MARK_READY';
    const nextStatus =
      resolution === 'MARK_PUBLISHED'
        ? 'PUBLISHED'
        : resolution === 'MARK_FAILED'
          ? 'FAILED'
          : 'READY';
    const now = new Date().toISOString();
    demo.posts = demo.posts.map((p) =>
      p.post_id === post.post_id
        ? {
            ...p,
            status: nextStatus,
            published_id: input.published_id ?? p.published_id,
            published_url: input.published_url ?? p.published_url,
            error: nextStatus === 'READY' ? '' : p.error,
            error_code: nextStatus === 'READY' ? '' : p.error_code,
            updated_at: now,
          }
        : p,
    );
    return { ok: true, post_id: post.post_id, status: nextStatus };
  }

  if (isSupabasePrimaryConfigured() && post.id) {
    const resolution = input.resolution ?? 'MARK_READY';
    const nextStatus =
      resolution === 'MARK_PUBLISHED'
        ? 'PUBLISHED'
        : resolution === 'MARK_FAILED'
          ? 'FAILED'
          : 'READY';
    const repo = new SupabaseRepository(fetchImpl);
    const updated = await repo.updatePost(
      {
        ...post,
        status: nextStatus,
        published_id: input.published_id ?? post.published_id,
        published_url: input.published_url ?? post.published_url,
        published_at: nextStatus === 'PUBLISHED' ? post.published_at || new Date().toISOString() : post.published_at,
        error: nextStatus === 'READY' || nextStatus === 'PUBLISHED' ? '' : post.error,
        error_code: nextStatus === 'READY' || nextStatus === 'PUBLISHED' ? '' : post.error_code,
      },
      'RECONCILE',
    );
    void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    return { ok: true, post_id: post.post_id, status: updated.status };
  }

  return n8nWebhookRequest(
    cfg.workflows.recoveryPath,
    {
      action: 'VERIFY_PUBLICATION',
      post_id: postId,
      resolution: input.resolution ?? 'CHECK_EXECUTION',
      published_id: input.published_id ?? '',
      published_url: input.published_url ?? '',
      request_id: crypto.randomUUID(),
    },
    35_000,
    fetchImpl,
  );
}

export async function getExecutionDetailSafe(
  executionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<N8nExecutionDetail> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const found = getDemoState().executions.find((e) => e.id === executionId);
    return {
      id: executionId,
      workflowId: found?.workflowId ?? 'demo-w01',
      workflowName: found?.workflowName ?? 'Demo Execution',
      status: found?.status ?? 'success',
      mode: found?.mode ?? 'webhook',
      startedAt: found?.startedAt ?? new Date().toISOString(),
      stoppedAt: found?.stoppedAt ?? new Date().toISOString(),
      finished: true,
      durationMs: found?.durationMs ?? 1200,
      lastNode: 'OUTPUT | Summary',
      errorMessage: '',
      nodes: [
        { name: 'WEBHOOK | Validate request', attempt: 1, durationMs: 12, status: 'success', error: '' },
        { name: 'SHEETS | Update record', attempt: 1, durationMs: 320, status: 'success', error: '' },
      ],
      reports: { demo: true },
    };
  }
  const detail = await getExecutionDetail(executionId, fetchImpl);
  if (detail.finished && !isActiveExecution(detail)) {
    const store = getLockStore();
    const jobs = await store.listJobs(50);
    const matched = jobs.find((j) => j.execution_id === executionId);
    if (matched && matched.status !== 'COMPLETED' && matched.status !== 'FAILED') {
      const nextStatus = detail.status === 'success' ? 'COMPLETED' : 'FAILED';
      await store.saveJob({
        ...matched,
        status: nextStatus,
        stage: nextStatus,
        error_message: detail.errorMessage || undefined,
        updated_at: new Date().toISOString(),
        finished_at: detail.stoppedAt ?? new Date().toISOString(),
      });
    }
  }
  return detail;
}

export async function updateRuntimeSettings(patch: {
  schedulingEnabled?: boolean;
}): Promise<{ schedulingEnabled: boolean }> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    const demo = getDemoState();
    if (typeof patch.schedulingEnabled === 'boolean') {
      demo.schedulingEnabled = patch.schedulingEnabled;
    }
    return { schedulingEnabled: demo.schedulingEnabled };
  }

  throw new AppError(
    'CONFIGURATION_ERROR',
    'Runtime feature flags (SCHEDULING_ENABLED, LIVE_PUBLISH_ENABLED, LIVE_DELETE_ENABLED) are controlled via server .env.local and online n8n workflow activation for safety.',
    { httpStatus: 409 },
  );
}
