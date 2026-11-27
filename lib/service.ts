import crypto from 'node:crypto';
import type {
  ContentRecord,
  DurableJob,
  ExecutionLogRecord,
  MediaAssetRecord,
  N8nExecutionDetail,
  N8nExecutionSummary,
  OverviewResponse,
  ReadinessMatrix,
  ServiceConnectionStatus,
  StorageSummary,
  SyncQueueRecord,
} from '../types/instaops';
import { getConfig, validateConfig } from './config/env';
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
import { verifyDownloaderAuth } from './downloader/client';
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

function canonicalPostLockKey(post: Pick<ContentRecord, 'id' | 'post_id'>): string {
  const idVal = (post.id ?? '').trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idVal);
  return `post:${isUuid ? idVal : post.post_id}`;
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
      // Prevent stale outbox revisions from overwriting newer authoritative post state in Google Sheets
      if (item.entity_type === 'POST' && item.source_revision && item.source_revision > 0) {
        const latest = await repo.getPostByIdOrUuid(item.entity_uuid);
        if (latest && Number(latest.revision) > item.source_revision) {
          await repo.markSyncSucceeded(item);
          succeeded++;
          continue;
        }
      }

      const syncRes = await n8nWebhookRequest<{ ok?: boolean; synced?: boolean }>(
        cfg.workflows.contentPath,
        {
          action: 'SYNC_RECORD',
          sync_id: item.id,
          entity_type: item.entity_type,
          entity_uuid: item.entity_uuid,
          external_id: item.external_id,
          operation: item.operation,
          source_revision: item.source_revision ?? 0,
          payload: item.payload,
          request_id: crypto.randomUUID(),
        },
        20_000,
        fetchImpl,
      );
      if (syncRes.synced === false || syncRes.ok === false) {
        throw new Error('Google Sheets sync write verification did not confirm persistence.');
      }
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
  const repo = new SupabaseRepository(fetchImpl);
  await repo.recoverAbandonedSyncJobs(180).catch(() => 0);
  const flushed = mode === 'FLUSH' ? await flushSyncQueueToSheets(fetchImpl) : undefined;
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

export async function getReadinessDiagnostics(
  fetchImpl: typeof fetch = fetch,
): Promise<{
  readiness: ReadinessMatrix;
  connections: ServiceConnectionStatus[];
  validation: ReturnType<typeof validateConfig>;
}> {
  const cfg = getConfig();
  const validation = validateConfig(cfg);
  const now = new Date().toISOString();

  if (cfg.demoMode) {
    const connections: ServiceConnectionStatus[] = [
      { id: 'supabase', name: 'Supabase PostgreSQL (Primary)', status: 'connected', detail: 'DEMO_MODE simulated primary DB + RLS + RPC', checkedAt: now },
      { id: 'n8n', name: 'Online n8n Server', status: 'connected', detail: 'DEMO_MODE simulated (W01-W05)', checkedAt: now },
      { id: 'downloader', name: 'Hosted Downloader', status: 'connected', detail: 'DEMO_MODE simulated Bearer auth', checkedAt: now },
      { id: 'sheets', name: 'Google Sheets (Sync Layer)', status: 'connected', detail: 'DEMO_MODE outbox simulated', checkedAt: now },
      { id: 'cloudinary', name: `Cloudinary (${cfg.cloudinaryCloudName})`, status: 'connected', detail: 'DEMO_MODE simulated', checkedAt: now },
      { id: 'instagram', name: `Instagram (${cfg.instagramAccountLabel})`, status: 'connected', detail: `ID ${cfg.instagramUserId} (Demo)`, checkedAt: now },
      { id: 'lockStore', name: 'Durable Lock Store', status: 'connected', detail: 'In-memory test lock', checkedAt: now },
      { id: 'ai', name: 'Optional AI Captioning', status: cfg.flags.aiCaptionEnabled ? 'connected' : 'unconfigured', detail: cfg.flags.aiCaptionEnabled ? 'Enabled' : 'Disabled by config', checkedAt: now },
    ];
    return {
      validation,
      connections,
      readiness: {
        configurationValid: true,
        supabaseReachable: true,
        databaseSchemaVerified: true,
        atomicRpcTested: true,
        rlsVerified: true,
        n8nAuthenticated: true,
        requiredWorkflowsConfigured: true,
        downloaderAuthVerified: true,
        cloudinaryAuthenticated: true,
        instagramAuthenticated: true,
        n8nEnvAccessOk: true,
        readyForExtraction: true,
        readyForPublishing: true,
        readyForDeletion: true,
      },
    };
  }

  const wfEntries: Array<{ key: 'extract' | 'publish' | 'schedule' | 'content' | 'recovery'; id: string; required: boolean }> = [
    { key: 'extract', id: cfg.workflows.extractId, required: true },
    { key: 'publish', id: cfg.workflows.publishId, required: true },
    { key: 'schedule', id: cfg.workflows.scheduleId, required: false },
    { key: 'content', id: cfg.workflows.contentId, required: true },
    { key: 'recovery', id: cfg.workflows.recoveryId, required: true },
  ];

  type RemoteRecoveryDiag = {
    supabase?: { ok?: boolean; detail?: string };
    sheets?: { ok?: boolean; detail?: string };
    cloudinary?: { ok?: boolean; detail?: string };
    instagram?: { ok?: boolean; detail?: string };
    n8nEnv?: {
      ok?: boolean;
      envBlocked?: boolean;
      livePublishEnabled?: boolean;
      liveDeleteEnabled?: boolean;
      schedulingEnabled?: boolean;
      detail?: string;
    };
  };

  const [sbDiag, dlAuth, wfChecks, remoteRecovery] = await Promise.all([
    cfg.supabaseUrl && cfg.supabaseServiceRoleKey
      ? new SupabaseRepository(fetchImpl).getHealthDiagnostics()
      : Promise.resolve({
          ok: false,
          reachable: false,
          schemaVerified: false,
          rlsVerified: false,
          anonRevoked: false,
          atomicRpcTested: false,
          activeAccountsCount: 0,
          detail: 'Missing SUPABASE_SERVICE_ROLE_KEY in .env.local',
          latencyMs: 0,
        }),
    verifyDownloaderAuth(fetchImpl, 8_000),
    cfg.n8nApiKey
      ? Promise.all(
          wfEntries.map(async (entry) => {
            if (!entry.id) return { ...entry, ok: false, active: false, error: 'Not configured' };
            try {
              const meta = await getWorkflowMetadata(entry.id, fetchImpl);
              return { ...entry, ok: true, active: meta.active, name: meta.name };
            } catch (e) {
              return { ...entry, ok: false, active: false, error: e instanceof Error ? e.message : String(e) };
            }
          }),
        )
      : Promise.resolve(wfEntries.map((entry) => ({ ...entry, ok: false, active: false, error: 'Missing N8N_API_KEY' }))),
    cfg.n8nWebhookSecret && cfg.workflows.recoveryPath
      ? n8nWebhookRequest<{ services?: RemoteRecoveryDiag }>(
          cfg.workflows.recoveryPath,
          { action: 'CHECK_CONNECTIONS', request_id: crypto.randomUUID() },
          8_000,
          fetchImpl,
        )
          .then((r) => r.services ?? null)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const lockStore = getLockStore();
  let lockOk = false;
  let lockDetail = 'Local fallback only (Supabase/Postgres lock backend missing; live publish/delete gated)';
  if (lockStore.mode === 'supabase') {
    lockOk = sbDiag.ok && sbDiag.atomicRpcTested;
    lockDetail = lockOk
      ? 'Supabase atomic lock/renew/release RPCs & RLS self-test verified'
      : `Supabase atomic RPC unverified: ${sbDiag.detail}`;
  } else if (lockStore.mode === 'postgres') {
    try {
      await lockStore.ensureSchema();
      lockOk = true;
      lockDetail = 'PostgreSQL atomic instaops_v2 schema verified';
    } catch (e) {
      lockDetail = `Lock store verification failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const contentWf = wfChecks.find((w) => w.key === 'content');
  const extractWf = wfChecks.find((w) => w.key === 'extract');
  const publishWf = wfChecks.find((w) => w.key === 'publish');
  const recoveryWf = wfChecks.find((w) => w.key === 'recovery');

  const n8nAuthenticated = Boolean(cfg.n8nApiKey) && wfChecks.some((w) => w.ok);
  const requiredWorkflowsConfigured = Boolean(
    extractWf?.ok && publishWf?.ok && contentWf?.ok && recoveryWf?.ok,
  );
  const allRequiredActive = Boolean(
    extractWf?.active && publishWf?.active && contentWf?.active && recoveryWf?.active,
  );

  const cloudinaryAuthenticated = Boolean(remoteRecovery?.cloudinary?.ok);
  const instagramAuthenticated = Boolean(remoteRecovery?.instagram?.ok);
  const n8nEnvAccessOk = remoteRecovery?.n8nEnv?.ok !== false && remoteRecovery?.n8nEnv?.envBlocked !== true;
  const n8nLivePublish = Boolean(remoteRecovery?.n8nEnv?.livePublishEnabled);
  const n8nLiveDelete = Boolean(remoteRecovery?.n8nEnv?.liveDeleteEnabled);

  const readiness: ReadinessMatrix = {
    configurationValid: validation.valid,
    supabaseReachable: sbDiag.reachable,
    databaseSchemaVerified: sbDiag.schemaVerified,
    atomicRpcTested: sbDiag.atomicRpcTested || (lockStore.mode === 'postgres' && lockOk),
    rlsVerified: sbDiag.rlsVerified && sbDiag.anonRevoked,
    n8nAuthenticated,
    requiredWorkflowsConfigured,
    downloaderAuthVerified: dlAuth.authVerified,
    cloudinaryAuthenticated,
    instagramAuthenticated,
    n8nEnvAccessOk,
    readyForExtraction: Boolean(
      validation.valid &&
        sbDiag.reachable &&
        sbDiag.schemaVerified &&
        lockOk &&
        n8nAuthenticated &&
        extractWf?.active &&
        dlAuth.authVerified &&
        cloudinaryAuthenticated &&
        n8nEnvAccessOk,
    ),
    readyForPublishing: Boolean(
      validation.valid &&
        sbDiag.reachable &&
        sbDiag.schemaVerified &&
        sbDiag.rlsVerified &&
        sbDiag.anonRevoked &&
        lockOk &&
        n8nAuthenticated &&
        publishWf?.active &&
        cloudinaryAuthenticated &&
        instagramAuthenticated &&
        cfg.flags.livePublishEnabled &&
        n8nLivePublish &&
        n8nEnvAccessOk,
    ),
    readyForDeletion: Boolean(
      validation.valid &&
        sbDiag.reachable &&
        sbDiag.schemaVerified &&
        sbDiag.rlsVerified &&
        sbDiag.anonRevoked &&
        lockOk &&
        n8nAuthenticated &&
        contentWf?.active &&
        cloudinaryAuthenticated &&
        cfg.flags.liveDeleteEnabled &&
        n8nLiveDelete &&
        n8nEnvAccessOk,
    ),
  };

  const statuses: ServiceConnectionStatus[] = [
    {
      id: 'supabase',
      name: 'Supabase PostgreSQL (Primary)',
      status: !cfg.supabaseServiceRoleKey
        ? 'unconfigured'
        : sbDiag.ok
          ? 'connected'
          : sbDiag.reachable
            ? 'degraded'
            : 'offline',
      detail: sbDiag.ok ? `Schema, RLS & atomic RPC verified (${sbDiag.detail})` : sbDiag.detail,
      checkedAt: now,
      latencyMs: sbDiag.latencyMs,
    },
    {
      id: 'n8n',
      name: `Online n8n (${cfg.n8nBaseUrl})`,
      status: !cfg.n8nApiKey
        ? 'unconfigured'
        : n8nAuthenticated && allRequiredActive && n8nEnvAccessOk
          ? 'connected'
          : n8nAuthenticated
            ? 'degraded'
            : 'offline',
      detail: !n8nAuthenticated
        ? String((contentWf && 'error' in contentWf ? contentWf.error : undefined) ?? 'Unable to authenticate n8n REST API')
        : !requiredWorkflowsConfigured
          ? 'n8n API authenticated, but one or more W01-W05 workflow IDs are missing/invalid'
          : !allRequiredActive
            ? 'Workflows imported, but one or more required W01/W02/W04/W05 workflows are inactive'
            : !n8nEnvAccessOk
              ? `Active, but n8n $env/secret access blocked or incomplete (${remoteRecovery?.n8nEnv?.detail ?? 'check N8N_BLOCK_ENV_ACCESS_IN_NODE=false'})`
              : 'All required workflows (W01, W02, W04, W05) active & verified',
      checkedAt: now,
    },
    {
      id: 'downloader',
      name: `Hosted Downloader (${cfg.downloaderBaseUrl})`,
      status: dlAuth.authVerified ? 'connected' : dlAuth.ok ? 'degraded' : 'offline',
      detail: dlAuth.detail,
      checkedAt: now,
      latencyMs: dlAuth.latencyMs,
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
      detail: remoteRecovery?.cloudinary?.detail ?? 'Verified via W05 Cloudinary API credential probe inside online n8n',
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

  return { readiness, connections: statuses, validation };
}

export async function getConnectionsHealth(
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceConnectionStatus[]> {
  const { connections } = await getReadinessDiagnostics(fetchImpl);
  return connections;
}

export async function getOverviewData(fetchImpl: typeof fetch = fetch): Promise<OverviewResponse> {
  const cfg = getConfig();
  const lockStore = getLockStore();
  const now = new Date().toISOString();

  if (cfg.demoMode) {
    const demo = getDemoState();
    const [jobs, locks, diag] = await Promise.all([
      lockStore.listJobs(50),
      lockStore.listActiveLocks(),
      getReadinessDiagnostics(fetchImpl),
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
      connections: diag.connections,
      readiness: diag.readiness,
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

  const [snapshotRes, execsRes, jobs, locks, diag] = await Promise.all([
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
    getReadinessDiagnostics(fetchImpl),
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
    connections: diag.connections,
    readiness: diag.readiness,
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

  const ov = await getOverviewData(fetchImpl);
  const post = ov.posts.find((p) => p.post_id === postId || p.id === postId);
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

  if (!cfg.demoMode) {
    if (!cfg.workflows.extractId) {
      throw new AppError('CONFIGURATION_ERROR', 'N8N_EXTRACT_WORKFLOW_ID is not configured.', { httpStatus: 500 });
    }
    const wf = await getWorkflowMetadata(cfg.workflows.extractId, fetchImpl);
    if (!wf.active) {
      throw new AppError('CONFIGURATION_ERROR', 'W01 Extract & Upload workflow is inactive in n8n.', { httpStatus: 409 });
    }
  }

  const lockKey = canonicalPostLockKey(post);
  const idemKey = input.idempotencyKey ?? `extract:${post.id ?? post.post_id}:${requestId}`;
  const idemClaim = await lockStore.claimIdempotency(idemKey, hashPayload({ postId: post.post_id, op: 'EXTRACT' }));
  if (!idemClaim.claimed) {
    throw new AppError(
      'POST_LOCKED',
      `Duplicate extraction request rejected for ${post.post_id} (${idemClaim.existingState ?? 'IN_PROGRESS'}).`,
      { httpStatus: 409 },
    );
  }

  await lockStore.acquireLock({
    lock_key: lockKey,
    post_uuid: post.id,
    post_id: post.post_id,
    operation: 'EXTRACT',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 600,
  });

  await lockStore.saveJob({
    ...createJobRecord({
      job_id: jobId,
      request_id: requestId,
      execution_id: '',
      post_id: post.post_id,
      operation: 'EXTRACT',
      stage: 'VALIDATING',
    }),
    lock_key: lockKey,
    lock_owner: ownerId,
    status: 'QUEUED',
  });

  let dispatchAttempted = false;
  try {
    if (cfg.demoMode) {
      const demo = getDemoState();
      const now = new Date().toISOString();
      const fakeUrl = `https://res.cloudinary.com/${cfg.cloudinaryCloudName}/video/upload/v1795709999/${buildOwnedPublicId(post.post_id, 0, post.source_id)}.mp4`;
      const asset: MediaAssetRecord = {
        internal_asset_id: `ast_${post.post_id}_0`,
        post_id: post.post_id,
        media_index: 0,
        media_type: post.media_type === 'IMAGE' ? 'IMAGE' : 'VIDEO',
        source_expires_at: '',
        cloudinary_public_id: buildOwnedPublicId(post.post_id, 0, post.source_id),
        cloudinary_asset_id: `cld_demo_${post.post_id}`,
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
      demo.posts = demo.posts.map((p) => (p.post_id === post.post_id ? updated : p));
      demo.assets = [asset, ...demo.assets.filter((a) => a.post_id !== post.post_id)];
      const execId = `demo-ext-${Date.now()}`;
      demo.executions.unshift({
        id: execId,
        workflowId: 'demo-w01',
        workflowName: 'W01 Extract & Upload (Demo)',
        postId: post.post_id,
        operation: 'EXTRACT',
        status: 'success',
        mode: 'webhook',
        startedAt: now,
        stoppedAt: now,
        finished: true,
        durationMs: 1200,
      });
      await lockStore.saveJob({
        ...createJobRecord({ job_id: jobId, request_id: requestId, execution_id: execId, post_id: post.post_id, operation: 'EXTRACT' }),
        lock_key: lockKey,
        lock_owner: ownerId,
        stage: 'COMPLETED',
        status: 'COMPLETED',
        finished_at: now,
      });
      await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', { ok: true, execution_id: execId });
      await lockStore.releaseLock(lockKey, ownerId);
      return { ok: true, accepted: true, request_id: requestId, job_id: jobId, execution_id: execId, post_id: post.post_id, status: 'QUEUED' };
    }

    dispatchAttempted = true;
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
        lock_key: lockKey,
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
        post_id: post.post_id,
        operation: 'EXTRACT',
        stage: 'FETCHING_SOURCE',
      }),
      lock_key: lockKey,
      lock_owner: ownerId,
      status: 'RUNNING',
    });
    const out: AcceptedJobResponse = {
      ok: true,
      accepted: true,
      request_id: requestId,
      job_id: jobId,
      execution_id: execId,
      post_id: post.post_id,
      status: 'QUEUED',
    };
    await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', out);
    return out;
  } catch (err) {
    const preSideEffect =
      !dispatchAttempted || (err instanceof AppError && err.httpStatus >= 400 && err.httpStatus < 500);
    await lockStore.saveJob({
      ...createJobRecord({
        job_id: jobId,
        request_id: requestId,
        post_id: post.post_id,
        operation: 'EXTRACT',
        stage: preSideEffect ? 'FAILED' : 'OUTCOME_UNKNOWN',
      }),
      lock_key: lockKey,
      lock_owner: ownerId,
      status: preSideEffect ? 'FAILED' : 'OUTCOME_UNKNOWN',
      error_code: err instanceof AppError ? err.code : 'DOWNLOADER_UNAVAILABLE',
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: preSideEffect ? new Date().toISOString() : undefined,
    });
    if (preSideEffect) {
      await lockStore.completeIdempotency(idemKey, 'FAILED', { ok: false, error: err instanceof Error ? err.message : String(err) });
      await lockStore.releaseLock(lockKey, ownerId);
    }
    throw err;
  }
}

/** Second click: Publish only the selected reviewed Reel/Image/Carousel with explicit atomic lock, persisted approval & timeout lock preservation. */
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

  let ov = await getOverviewData(fetchImpl);
  const initialPost = ov.posts.find((p) => p.post_id === postId || p.id === postId);
  if (!initialPost) throw new AppError('POST_NOT_FOUND', `Post ${postId} not found.`, { httpStatus: 404 });
  let post: ContentRecord = initialPost;

  if (post.revision !== input.reviewedRevision) {
    throw new AppError(
      'REVISION_CONFLICT',
      `Content changed since review (expected rev ${input.reviewedRevision}, actual ${post.revision}). Refresh and review again.`,
      { httpStatus: 409 },
    );
  }

  if (!cfg.demoMode) {
    if (!cfg.workflows.publishId) {
      throw new AppError('CONFIGURATION_ERROR', 'N8N_PUBLISH_WORKFLOW_ID is not configured.', { httpStatus: 500 });
    }
    const wf = await getWorkflowMetadata(cfg.workflows.publishId, fetchImpl);
    if (!wf.active) {
      throw new AppError('CONFIGURATION_ERROR', 'W02 Publish Content workflow is inactive in n8n.', { httpStatus: 409 });
    }
    if (isSupabasePrimaryConfigured() && post.id) {
      const repo = new SupabaseRepository(fetchImpl);
      const acctEnabled = await repo.isDestinationAccountEnabled(post.ig_user_id || cfg.instagramUserId, post.account_key);
      if (!acctEnabled) {
        throw new AppError('CONFIGURATION_ERROR', 'Destination Instagram account is disabled or missing in database.', {
          httpStatus: 422,
        });
      }
      if (await repo.hasUnresolvedPublishAttempt(post.id)) {
        throw new AppError('POST_LOCKED', `Unresolved previous publication attempt exists for ${post.post_id}. Reconcile first.`, {
          httpStatus: 409,
        });
      }
    }
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const ownerId = `pub:${requestId}`;
  const lockKey = canonicalPostLockKey(post);
  const idemKey = input.idempotencyKey ?? `publish:${post.id ?? post.post_id}:${input.reviewedRevision}`;

  const claim = await lockStore.claimIdempotency<AcceptedJobResponse>(
    idemKey,
    hashPayload({ postId: post.post_id, rev: input.reviewedRevision, op: 'PUBLISH' }),
  );
  if (!claim.claimed) {
    throw new AppError(
      'POST_LOCKED',
      `Duplicate publish request rejected for ${post.post_id} revision ${input.reviewedRevision} (${claim.existingState ?? 'IN_PROGRESS'}).`,
      { httpStatus: 409 },
    );
  }

  await lockStore.acquireLock({
    lock_key: lockKey,
    post_uuid: post.id,
    post_id: post.post_id,
    operation: 'PUBLISH',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 600,
  });

  let dispatchAttempted = false;
  try {
    if (input.caption !== undefined && input.caption !== post.caption) {
      validateCaptionLength(input.caption, {
        allowEmpty: input.allowEmptyCaption === true || Boolean(post.original_caption.trim()),
      });
      post = await updatePostRecord(
        post.post_id,
        { caption: input.caption, allowEmptyCaption: input.allowEmptyCaption },
        fetchImpl,
      );
      ov = await getOverviewData(fetchImpl);
      post = ov.posts.find((p) => p.post_id === post.post_id) ?? post;
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

    // Persist manual approval atomically BEFORE dispatching W02 or saving durable job
    if (cfg.demoMode) {
      const demo = getDemoState();
      post = { ...post, approved_revision: post.revision, updated_at: new Date().toISOString() };
      demo.posts = demo.posts.map((p) => (p.post_id === post.post_id ? post : p));
    } else if (isSupabasePrimaryConfigured() && post.id) {
      post = await new SupabaseRepository(fetchImpl).approvePostRevision(post.id, Number(post.revision));
    } else {
      post = { ...post, approved_revision: post.revision };
    }

    await lockStore.saveJob({
      ...createJobRecord({
        job_id: jobId,
        request_id: requestId,
        execution_id: '',
        post_id: post.post_id,
        operation: 'PUBLISH',
        stage: 'CREATING_CONTAINER',
      }),
      lock_key: lockKey,
      lock_owner: ownerId,
      status: 'QUEUED',
    });

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
        lock_key: lockKey,
        lock_owner: ownerId,
        stage: 'COMPLETED',
        status: 'COMPLETED',
        finished_at: now,
      });
      await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', { ok: true, execution_id: execId });
      await lockStore.releaseLock(lockKey, ownerId);
      return { ok: true, accepted: true, request_id: requestId, job_id: jobId, execution_id: execId, post_id: post.post_id, status: 'QUEUED' };
    }

    dispatchAttempted = true;
    const hookRes = await n8nWebhookRequest<{ accepted?: boolean; execution_id?: string }>(
      cfg.workflows.publishPath,
      {
        action: 'PUBLISH',
        post_uuid: post.id ?? '',
        post_id: post.post_id,
        account_key: post.account_key,
        ig_user_id: post.ig_user_id || cfg.instagramUserId,
        media_type: post.media_type,
        caption: post.caption || post.original_caption,
        media_url: post.media_url,
        media_items: mediaItems,
        reviewed_revision: post.revision,
        approved_revision: post.revision,
        review_snapshot: reviewedSnapshot,
        request_id: requestId,
        job_id: jobId,
        lock_key: lockKey,
        lock_owner: ownerId,
        confirm: true,
      },
      35_000,
      fetchImpl,
    );

    if (hookRes.accepted !== true || !hookRes.execution_id) {
      throw new AppError(
        'PUBLISH_OUTCOME_UNKNOWN',
        'Online n8n W02 did not confirm execution acceptance; reconcile before retrying.',
        { httpStatus: 502 },
      );
    }

    const execId = String(hookRes.execution_id);
    await lockStore.saveJob({
      ...createJobRecord({
        job_id: jobId,
        request_id: requestId,
        execution_id: execId,
        post_id: post.post_id,
        operation: 'PUBLISH',
        stage: 'CREATING_CONTAINER',
      }),
      lock_key: lockKey,
      lock_owner: ownerId,
      status: 'RUNNING',
    });

    const out: AcceptedJobResponse = {
      ok: true,
      accepted: true,
      request_id: requestId,
      job_id: jobId,
      execution_id: execId,
      post_id: post.post_id,
      status: 'QUEUED',
    };
    await lockStore.completeIdempotency(idemKey, 'SUCCEEDED', out);
    return out;
  } catch (err) {
    const preSideEffect =
      !dispatchAttempted ||
      (err instanceof AppError &&
        err.httpStatus >= 400 &&
        err.httpStatus < 500 &&
        err.code !== 'PUBLISH_OUTCOME_UNKNOWN');

    if (preSideEffect) {
      await lockStore.saveJob({
        ...createJobRecord({
          job_id: jobId,
          request_id: requestId,
          post_id: post.post_id,
          operation: 'PUBLISH',
          stage: 'FAILED',
        }),
        lock_key: lockKey,
        lock_owner: ownerId,
        status: 'FAILED',
        error_code: err instanceof AppError ? err.code : 'INSTAGRAM_PUBLISH_FAILED',
        error_message: err instanceof Error ? err.message : String(err),
        finished_at: new Date().toISOString(),
      });
      await lockStore.completeIdempotency(idemKey, 'FAILED', { ok: false, error: err instanceof Error ? err.message : String(err) });
      await lockStore.releaseLock(lockKey, ownerId);
      throw err;
    }

    // Uncertain publication dispatch (e.g., webhook timeout / 5xx after transfer): NEVER release the lock!
    const errMsg = err instanceof Error ? err.message : String(err);
    await lockStore.saveJob({
      ...createJobRecord({
        job_id: jobId,
        request_id: requestId,
        post_id: post.post_id,
        operation: 'PUBLISH',
        stage: 'OUTCOME_UNKNOWN',
      }),
      lock_key: lockKey,
      lock_owner: ownerId,
      status: 'OUTCOME_UNKNOWN',
      error_code: 'PUBLISH_OUTCOME_UNKNOWN',
      error_message: errMsg,
    });
    if (isSupabasePrimaryConfigured() && post.id) {
      await new SupabaseRepository(fetchImpl)
        .updatePost(
          {
            ...post,
            status: 'VERIFY_MANUALLY',
            error_code: 'PUBLISH_OUTCOME_UNKNOWN',
            error_stage: 'PUBLISH_REQUESTED',
            error: `Uncertain W02 publish outcome (${errMsg.slice(0, 220)}); verify provider before retrying.`,
          },
          'PUBLISH_TIMEOUT',
        )
        .catch(() => undefined);
    }
    throw err instanceof AppError && err.code === 'PUBLISH_OUTCOME_UNKNOWN'
      ? err
      : new AppError(
          'PUBLISH_OUTCOME_UNKNOWN',
          `Publish webhook outcome uncertain (${errMsg}); lock preserved until manual reconciliation.`,
          { httpStatus: 502 },
        );
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
    if (post.id && (await repo.hasUnresolvedPublishAttempt(post.id))) {
      throw new AppError('POST_LOCKED', `Unresolved previous publication attempt exists for ${post.post_id}. Reconcile first.`, {
        httpStatus: 409,
      });
    }
    if (cfg.instagramUserId || post.ig_user_id) {
      const enabled = await repo.isDestinationAccountEnabled(post.ig_user_id || cfg.instagramUserId, post.account_key);
      if (!enabled) {
        throw new AppError(
          'CONFIGURATION_ERROR',
          `Destination Instagram account (${post.account_key} / ${post.ig_user_id || cfg.instagramUserId}) is disabled in instaops_accounts.`,
          { httpStatus: 409 },
        );
      }
    }
    const lockStore = getLockStore();
    const lockKey = canonicalPostLockKey(post);
    const reqId = crypto.randomUUID();
    const ownerId = `sched:${reqId}`;
    await lockStore.acquireLock({
      lock_key: lockKey,
      post_uuid: post.id,
      post_id: post.post_id,
      operation: 'SCHEDULE',
      owner_id: ownerId,
      request_id: reqId,
      leaseSeconds: 120,
    });
    try {
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
    } finally {
      await lockStore.releaseLock(lockKey, ownerId).catch(() => undefined);
    }
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

async function loadAuthoritativeDeletionState(
  postOrId: string,
  fetchImpl: typeof fetch,
): Promise<{ post: ContentRecord; assets: MediaAssetRecord[] }> {
  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const post = await repo.getPostByIdOrUuid(postOrId);
    if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postOrId} not found.`, { httpStatus: 404 });
    const assets = await repo.listMediaAssets(post.post_id);
    return { post, assets };
  }
  const ov = await getOverviewData(fetchImpl);
  const post = ov.posts.find((p) => p.post_id === postOrId || p.id === postOrId);
  if (!post) throw new AppError('POST_NOT_FOUND', `Post ${postOrId} not found.`, { httpStatus: 404 });
  return { post, assets: ov.assets };
}

function classifyDeletionOutcomesStrict(
  requestedAssets: MediaAssetRecord[],
  rawOutcomes: Array<{ internal_asset_id?: string; public_id?: string; result?: string; error?: string }> | undefined,
): {
  confirmedIds: string[];
  failedList: Array<{ internal_asset_id: string; error: string }>;
} {
  const summary = summarizeDeletionOutcomes(
    (rawOutcomes ?? []).map((o) => ({
      internal_asset_id: String(o.internal_asset_id ?? ''),
      public_id: String(o.public_id ?? ''),
      result: o.result,
      error: o.error,
    })),
  );
  const confirmedSet = new Set([...summary.succeededIds, ...summary.alreadyMissingIds]);
  const failedMap = new Map<string, string>();
  for (const f of summary.failed) {
    if (f.internal_asset_id) failedMap.set(f.internal_asset_id, f.error);
  }
  for (const a of requestedAssets) {
    if (!confirmedSet.has(a.internal_asset_id) && !failedMap.has(a.internal_asset_id)) {
      failedMap.set(a.internal_asset_id, 'Deletion outcome missing/unconfirmed from Cloudinary destroy response.');
    }
  }
  return {
    confirmedIds: Array.from(confirmedSet),
    failedList: Array.from(failedMap.entries()).map(([internal_asset_id, error]) => ({ internal_asset_id, error })),
  };
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
    (cfg.atomicLockProvider === 'postgres' && Boolean(cfg.databaseUrl));
  if (!input.confirm) throw new AppError('UNAUTHORIZED_CONTENT', 'Confirmation required.', { httpStatus: 403 });
  if (!cfg.demoMode && (!cfg.flags.liveDeleteEnabled || !hasDurableCoord)) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Live Cloudinary deletion is disabled until Supabase/Postgres locking is configured and LIVE_DELETE_ENABLED=true.',
      { httpStatus: 409 },
    );
  }

  const { post, assets } = await loadAuthoritativeDeletionState(postId, fetchImpl);
  if (['PUBLISHING', 'VERIFY_MANUALLY', 'EXTRACTING', 'UPLOADING'].includes(post.status)) {
    throw new AppError('POST_LOCKED', `Cannot delete media while post ${post.post_id} is ${post.status}.`, {
      httpStatus: 409,
    });
  }

  const ownedAssets = assets.filter(
    (a) => a.post_id === post.post_id && ['ACTIVE', 'DELETE_PENDING', 'PARTIAL_DELETE'].includes(a.storage_status),
  );
  if (!ownedAssets.length) {
    throw new AppError('MEDIA_UNAVAILABLE', `Post ${post.post_id} has no active managed Cloudinary assets.`, {
      httpStatus: 404,
    });
  }
  for (const asset of ownedAssets) {
    assertDeletableAssetOwnership(asset, post);
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const ownerId = `delmedia:${requestId}`;
  const lockKey = canonicalPostLockKey(post);

  await lockStore.acquireLock({
    lock_key: lockKey,
    post_uuid: post.id,
    post_id: post.post_id,
    operation: 'DELETE_MEDIA',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 300,
  });

  await lockStore.saveJob({
    ...createJobRecord({
      job_id: jobId,
      request_id: requestId,
      post_id: post.post_id,
      operation: 'DELETE_MEDIA',
      stage: 'DELETING_ASSETS',
    }),
    lock_key: lockKey,
    lock_owner: ownerId,
    status: 'RUNNING',
  });

  try {
    if (cfg.demoMode) {
      const demo = getDemoState();
      const now = new Date().toISOString();
      demo.assets = demo.assets.map((a) =>
        a.post_id === post.post_id && a.storage_status === 'ACTIVE'
          ? { ...a, storage_status: 'DELETED', deleted_at: now, updated_at: now }
          : a,
      );
      const nextStatus = isPublishedRecord(post) ? post.status : 'MEDIA_DELETED';
      demo.posts = demo.posts.map((p) =>
        p.post_id === post.post_id
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
      await lockStore.saveJob({
        ...createJobRecord({ job_id: jobId, request_id: requestId, post_id: post.post_id, operation: 'DELETE_MEDIA', stage: 'COMPLETED' }),
        status: 'COMPLETED',
        finished_at: now,
      });
      return {
        post_id: post.post_id,
        deletedAssets: ownedAssets.map((a) => a.internal_asset_id),
        status: nextStatus,
      };
    }

    if (!cfg.n8nWebhookSecret) {
      throw new AppError('CONFIGURATION_ERROR', 'N8N_WEBHOOK_SECRET is required to destroy Cloudinary media.', {
        httpStatus: 500,
      });
    }

    const repo = isSupabasePrimaryConfigured() && post.id ? new SupabaseRepository(fetchImpl) : null;
    if (repo && post.id) {
      await repo.markAssetsDeletePending(
        post.id,
        ownedAssets.map((a) => a.internal_asset_id),
      );
    }

    const res = await n8nWebhookRequest<{
      ok: true;
      outcomes?: Array<{ internal_asset_id?: string; public_id?: string; result?: string; error?: string }>;
      status?: string;
    }>(
      cfg.workflows.contentPath,
      {
        action: 'DELETE_MEDIA',
        post_uuid: post.id ?? '',
        post_id: post.post_id,
        asset_ids: ownedAssets.map((a) => a.internal_asset_id),
        assets: ownedAssets.map((a) => ({
          asset_uuid: a.id ?? '',
          internal_asset_id: a.internal_asset_id,
          public_id: a.cloudinary_public_id,
          resource_type: a.resource_type,
          delivery_type: a.delivery_type,
        })),
        confirm: true,
        request_id: requestId,
      },
      60_000,
      fetchImpl,
    );

    const { confirmedIds, failedList } = classifyDeletionOutcomesStrict(ownedAssets, res.outcomes);
    const nextStatus = isPublishedRecord(post) ? post.status : failedList.length > 0 ? 'FAILED' : 'MEDIA_DELETED';

    if (repo && post.id) {
      try {
        await repo.finalizeDeletionCheckpoint({
          postUuid: post.id,
          operation: 'DELETE_MEDIA',
          confirmedAssetIds: confirmedIds,
          failedAssets: failedList,
          reason: input.reason,
          jobId,
          lockKey,
          lockOwner: ownerId,
        });
        void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
      } catch (dbErr) {
        await lockStore.saveJob({
          ...createJobRecord({ job_id: jobId, request_id: requestId, post_id: post.post_id, operation: 'DELETE_MEDIA', stage: 'OUTCOME_UNKNOWN' }),
          lock_key: lockKey,
          lock_owner: ownerId,
          status: 'OUTCOME_UNKNOWN',
          error_code: 'DELETE_OUTCOME_UNKNOWN',
          error_message: `Confirmed Cloudinary delete (${confirmedIds.join(',')}), DB update failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        });
        throw dbErr;
      }
    }

    if (failedList.length > 0) {
      throw new AppError(
        'CLOUDINARY_DELETE_FAILED',
        `Partial Cloudinary deletion failure (${failedList.length} asset(s) failed; ${confirmedIds.length} checkpointed as deleted).`,
        { httpStatus: 502, details: { confirmedIds, failed: failedList } },
      );
    }

    return {
      post_id: post.post_id,
      deletedAssets: confirmedIds,
      status: nextStatus,
    };
  } finally {
    await lockStore.releaseLock(lockKey, ownerId);
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
    (cfg.atomicLockProvider === 'postgres' && Boolean(cfg.databaseUrl));
  if (!input.confirm) throw new AppError('UNAUTHORIZED_CONTENT', 'Confirmation required.', { httpStatus: 403 });
  if (!cfg.demoMode && (!cfg.flags.liveDeleteEnabled || !hasDurableCoord)) {
    throw new AppError('CONFIGURATION_ERROR', 'Live deletion requires LIVE_DELETE_ENABLED=true and Supabase/Postgres locking.', {
      httpStatus: 409,
    });
  }

  let asset: MediaAssetRecord | undefined;
  let parent: ContentRecord | undefined;
  if (isSupabasePrimaryConfigured()) {
    const repo = new SupabaseRepository(fetchImpl);
    const allAssets = await repo.listMediaAssets();
    asset = allAssets.find((a) => a.internal_asset_id === internalAssetId || a.id === internalAssetId);
    if (asset) {
      parent = (await repo.getPostByIdOrUuid(asset.post_uuid || asset.post_id)) ?? undefined;
    }
  } else {
    const ov = await getOverviewData(fetchImpl);
    asset = ov.assets.find((a) => a.internal_asset_id === internalAssetId);
    parent = asset ? ov.posts.find((p) => p.post_id === asset!.post_id) : undefined;
  }

  if (!asset) {
    throw new AppError('POST_NOT_FOUND', `Media asset ${internalAssetId} not found in MediaAssets records.`, {
      httpStatus: 404,
    });
  }
  assertDeletableAssetOwnership(asset, parent);

  if (cfg.demoMode) {
    const demo = getDemoState();
    const now = new Date().toISOString();
    demo.assets = demo.assets.map((a) =>
      a.internal_asset_id === asset.internal_asset_id
        ? { ...a, storage_status: 'DELETED', deleted_at: now, updated_at: now }
        : a,
    );
    const remaining = demo.assets.filter(
      (a) => a.post_id === asset!.post_id && a.storage_status === 'ACTIVE',
    );
    if (parent) {
      demo.posts = demo.posts.map((p) =>
        p.post_id === asset!.post_id
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
    return { internal_asset_id: asset.internal_asset_id, storage_status: 'DELETED' };
  }

  if (!cfg.n8nWebhookSecret) {
    throw new AppError('CONFIGURATION_ERROR', 'N8N_WEBHOOK_SECRET is required to destroy Cloudinary media.', {
      httpStatus: 500,
    });
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const ownerId = `delasset:${requestId}`;
  const lockKey = parent ? canonicalPostLockKey(parent) : `post:${asset.post_id}`;
  await lockStore.acquireLock({
    lock_key: lockKey,
    post_uuid: parent?.id,
    post_id: asset.post_id,
    operation: 'DELETE_MEDIA',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 300,
  });

  await lockStore.saveJob({
    ...createJobRecord({ job_id: jobId, request_id: requestId, post_id: asset.post_id, operation: 'DELETE_MEDIA', stage: 'DELETING_ASSETS' }),
    lock_key: lockKey,
    lock_owner: ownerId,
    status: 'RUNNING',
  });

  try {
    const repo = isSupabasePrimaryConfigured() && parent?.id ? new SupabaseRepository(fetchImpl) : null;
    if (repo && parent?.id) {
      await repo.markAssetsDeletePending(parent.id, [asset.internal_asset_id]);
    }

    const res = await n8nWebhookRequest<{
      ok: true;
      outcomes?: Array<{ internal_asset_id?: string; public_id?: string; result?: string; error?: string }>;
    }>(
      cfg.workflows.contentPath,
      {
        action: 'DELETE_MEDIA',
        post_uuid: parent?.id ?? '',
        post_id: asset.post_id,
        asset_ids: [asset.internal_asset_id],
        assets: [
          {
            asset_uuid: asset.id ?? '',
            internal_asset_id: asset.internal_asset_id,
            public_id: asset.cloudinary_public_id,
            resource_type: asset.resource_type,
            delivery_type: asset.delivery_type,
          },
        ],
        confirm: true,
        request_id: requestId,
      },
      60_000,
      fetchImpl,
    );

    const { confirmedIds, failedList } = classifyDeletionOutcomesStrict([asset], res.outcomes);
    if (repo && parent?.id) {
      await repo.finalizeDeletionCheckpoint({
        postUuid: parent.id,
        operation: 'DELETE_MEDIA',
        confirmedAssetIds: confirmedIds,
        failedAssets: failedList,
        reason: input.reason,
        jobId,
        lockKey,
        lockOwner: ownerId,
      });
      void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
    }

    if (failedList.length > 0 || !confirmedIds.includes(asset.internal_asset_id)) {
      throw new AppError(
        'CLOUDINARY_DELETE_FAILED',
        failedList[0]?.error || `Cloudinary did not confirm deletion of ${asset.internal_asset_id}.`,
        { httpStatus: 502 },
      );
    }
    return { internal_asset_id: asset.internal_asset_id, storage_status: 'DELETED' };
  } finally {
    await lockStore.releaseLock(lockKey, ownerId);
  }
}

/** Option B: Soft-delete the Supabase/Sheets post record ONLY after every active Cloudinary asset deletion is verified. */
export async function deletePostAndMedia(
  postId: string,
  input: DeleteConfirmInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ post_id: string; status: 'DELETED' }> {
  const cfg = getConfig();
  const hasDurableCoord =
    (cfg.atomicLockProvider === 'supabase' && Boolean(cfg.supabaseUrl && cfg.supabaseServiceRoleKey)) ||
    (cfg.atomicLockProvider === 'postgres' && Boolean(cfg.databaseUrl));
  if (!input.confirm) throw new AppError('UNAUTHORIZED_CONTENT', 'Confirmation required.', { httpStatus: 403 });
  if (!cfg.demoMode && (!cfg.flags.liveDeleteEnabled || !hasDurableCoord)) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Live post deletion is disabled until Supabase/Postgres locking is configured and LIVE_DELETE_ENABLED=true.',
      { httpStatus: 409 },
    );
  }

  const { post, assets } = await loadAuthoritativeDeletionState(postId, fetchImpl);
  assertPostDeletable(post, assets);

  if (isSupabasePrimaryConfigured() && post.id) {
    const unresolvedPublish = await new SupabaseRepository(fetchImpl).hasUnresolvedPublishAttempt(post.id);
    if (unresolvedPublish) {
      throw new AppError('POST_LOCKED', `Cannot delete post ${post.post_id} while publish job is active or unresolved.`, {
        httpStatus: 409,
      });
    }
  }

  const lockStore = getLockStore();
  const requestId = crypto.randomUUID();
  const jobId = `job_${crypto.randomUUID().slice(0, 12)}`;
  const ownerId = `delpost:${requestId}`;
  const lockKey = canonicalPostLockKey(post);

  await lockStore.acquireLock({
    lock_key: lockKey,
    post_uuid: post.id,
    post_id: post.post_id,
    operation: 'DELETE_POST',
    owner_id: ownerId,
    request_id: requestId,
    leaseSeconds: 300,
  });

  await lockStore.saveJob({
    ...createJobRecord({ job_id: jobId, request_id: requestId, post_id: post.post_id, operation: 'DELETE_POST', stage: 'DELETING_ASSETS' }),
    lock_key: lockKey,
    lock_owner: ownerId,
    status: 'RUNNING',
  });

  try {
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
      await lockStore.saveJob({
        ...createJobRecord({ job_id: jobId, request_id: requestId, post_id: post.post_id, operation: 'DELETE_POST', stage: 'COMPLETED' }),
        status: 'COMPLETED',
        finished_at: now,
      });
      return { post_id: post.post_id, status: 'DELETED' };
    }

    if (isSupabasePrimaryConfigured() && post.id) {
      const repo = new SupabaseRepository(fetchImpl);
      const targetAssets = assets.filter(
        (a) =>
          a.post_id === post.post_id &&
          ['ACTIVE', 'DELETE_PENDING', 'PARTIAL_DELETE'].includes(a.storage_status) &&
          Boolean(a.cloudinary_public_id),
      );
      for (const a of targetAssets) {
        assertDeletableAssetOwnership(a, post);
      }

      let confirmedIds: string[] = [];
      let failedList: Array<{ internal_asset_id: string; error: string }> = [];

      if (targetAssets.length > 0) {
        if (!cfg.n8nWebhookSecret) {
          throw new AppError(
            'CONFIGURATION_ERROR',
            'N8N_WEBHOOK_SECRET is required to verify Cloudinary asset deletion before soft-deleting the post.',
            { httpStatus: 500 },
          );
        }

        await repo.markAssetsDeletePending(
          post.id,
          targetAssets.map((a) => a.internal_asset_id),
        );

        const delRes = await n8nWebhookRequest<{
          ok?: boolean;
          outcomes?: Array<{ internal_asset_id?: string; public_id?: string; result?: string; error?: string }>;
        }>(
          cfg.workflows.contentPath,
          {
            action: 'DELETE_MEDIA',
            post_uuid: post.id,
            post_id: post.post_id,
            asset_ids: targetAssets.map((a) => a.internal_asset_id),
            assets: targetAssets.map((a) => ({
              asset_uuid: a.id ?? '',
              internal_asset_id: a.internal_asset_id,
              public_id: a.cloudinary_public_id,
              resource_type: a.resource_type,
              delivery_type: a.delivery_type,
            })),
            confirm: true,
            request_id: requestId,
          },
          60_000,
          fetchImpl,
        );

        ({ confirmedIds, failedList } = classifyDeletionOutcomesStrict(targetAssets, delRes.outcomes));
      }

      try {
        await repo.finalizeDeletionCheckpoint({
          postUuid: post.id,
          operation: failedList.length === 0 ? 'DELETE_POST' : 'DELETE_MEDIA',
          confirmedAssetIds: confirmedIds,
          failedAssets: failedList,
          reason: input.reason ?? '',
          jobId,
          lockKey,
          lockOwner: ownerId,
        });
        void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
      } catch (dbErr) {
        await lockStore.saveJob({
          ...createJobRecord({ job_id: jobId, request_id: requestId, post_id: post.post_id, operation: 'DELETE_POST', stage: 'OUTCOME_UNKNOWN' }),
          lock_key: lockKey,
          lock_owner: ownerId,
          status: 'OUTCOME_UNKNOWN',
          error_code: 'DELETE_OUTCOME_UNKNOWN',
          error_message: `Cloudinary deleted (${confirmedIds.join(',')}) but Supabase finalization failed: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        });
        throw dbErr;
      }

      if (failedList.length > 0) {
        throw new AppError(
          'CLOUDINARY_DELETE_FAILED',
          `Parent post NOT deleted because ${failedList.length} Cloudinary asset deletion(s) failed (${confirmedIds.length} confirmed deleted checkpointed).`,
          { httpStatus: 502, details: { confirmedIds, failed: failedList } },
        );
      }

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
    await lockStore.releaseLock(lockKey, ownerId);
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
    const repo = new SupabaseRepository(fetchImpl);

    // Live provider verification is REQUIRED before marking any post PUBLISHED or resolving uncertain executions.
    if (resolution === 'MARK_PUBLISHED' || resolution === 'CHECK_EXECUTION') {
      if (!cfg.workflows.recoveryPath || !cfg.n8nWebhookSecret) {
        throw new AppError(
          'CONFIGURATION_ERROR',
          'Live Instagram Graph API verification via W05 (N8N_RECOVERY_PATH + N8N_WEBHOOK_SECRET) is required before reconciling publication state.',
          { httpStatus: 409 },
        );
      }
      const verifiedRes = await n8nWebhookRequest<{
        ok?: boolean;
        verified?: boolean;
        status?: string;
        published_id?: string;
        published_url?: string;
        error?: string;
      }>(
        cfg.workflows.recoveryPath,
        {
          action: 'VERIFY_PUBLICATION',
          post_uuid: post.id,
          post_id: post.post_id,
          container_id: post.container_id,
          execution_id: post.execution_id,
          ig_user_id: post.ig_user_id || cfg.instagramUserId,
          resolution,
          published_id: input.published_id ?? '',
          published_url: input.published_url ?? '',
          request_id: crypto.randomUUID(),
        },
        35_000,
        fetchImpl,
      );

      if (resolution === 'MARK_PUBLISHED' && (!verifiedRes.verified || verifiedRes.status !== 'PUBLISHED' || !verifiedRes.published_id)) {
        throw new AppError(
          'PUBLISH_OUTCOME_UNKNOWN',
          verifiedRes.error || 'Meta Graph API did not verify this media ID/container as published; post cannot be marked PUBLISHED.',
          { httpStatus: 422 },
        );
      }

      const verifiedStatus = (verifiedRes.status as ContentRecord['status']) || (resolution === 'MARK_PUBLISHED' ? 'PUBLISHED' : post.status);
      const updated = await repo.updatePost(
        {
          ...post,
          status: verifiedStatus,
          published_id: verifiedRes.published_id ?? post.published_id,
          published_url: verifiedRes.published_url ?? post.published_url,
          published_at: verifiedStatus === 'PUBLISHED' ? post.published_at || new Date().toISOString() : post.published_at,
          error: verifiedStatus === 'READY' || verifiedStatus === 'PUBLISHED' ? '' : post.error,
          error_code: verifiedStatus === 'READY' || verifiedStatus === 'PUBLISHED' ? '' : post.error_code,
        },
        'RECONCILE',
      );
      if (verifiedStatus === 'PUBLISHED' || verifiedStatus === 'FAILED' || verifiedStatus === 'READY') {
        const activeLocks = await lockStore.listActiveLocks().catch(() => []);
        for (const lk of activeLocks) {
          if (lk.lock_key === canonicalPostLockKey(post) || lk.post_id === post.post_id) {
            await lockStore.releaseLock(lk.lock_key, lk.owner_id).catch(() => undefined);
          }
        }
      }
      void flushSyncQueueToSheets(fetchImpl).catch(() => undefined);
      return { ok: true, verified: Boolean(verifiedRes.verified), post_id: post.post_id, status: updated.status, published_id: updated.published_id };
    }

    const nextStatus = resolution === 'MARK_FAILED' ? 'FAILED' : 'READY';
    const updated = await repo.updatePost(
      {
        ...post,
        status: nextStatus,
        error: nextStatus === 'READY' ? '' : post.error,
        error_code: nextStatus === 'READY' ? '' : post.error_code,
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
      post_uuid: post.id ?? '',
      post_id: post.post_id,
      container_id: post.container_id,
      execution_id: post.execution_id,
      ig_user_id: post.ig_user_id || cfg.instagramUserId,
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
