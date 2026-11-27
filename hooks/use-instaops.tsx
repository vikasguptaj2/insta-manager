'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type {
  ContentRecord,
  DurableJob,
  ExecutionLogRecord,
  MediaAssetRecord,
  N8nExecutionDetail,
  OverviewResponse,
  PostEligibility,
  ServiceConnectionStatus,
} from '../types/instaops';

export interface ToastMessage {
  id: string;
  kind: 'success' | 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
}

export interface ApiClientError extends Error {
  code?: string;
  retryable?: boolean;
  details?: unknown;
}

async function callApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  let payload: Record<string, unknown> | null = null;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    payload = null;
  }
  if (!res.ok || !payload || payload.ok === false) {
    const errObj = (payload?.error ?? {}) as {
      message?: string;
      code?: string;
      retryable?: boolean;
      details?: unknown;
    };
    const err: ApiClientError = new Error(errObj.message || `Request failed (HTTP ${res.status})`);
    err.code = errObj.code;
    err.retryable = errObj.retryable;
    err.details = errObj.details;
    throw err;
  }
  return payload as T;
}

export interface PostDetailBundle {
  post: ContentRecord;
  assets: MediaAssetRecord[];
  logs: ExecutionLogRecord[];
  eligibility: PostEligibility;
}

interface InstaOpsContextValue {
  overview: OverviewResponse | null;
  loading: boolean;
  refreshing: boolean;
  loadError: string | null;
  lastSyncedAt: string | null;
  autoRefresh: boolean;
  setAutoRefresh: (val: boolean) => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  toasts: ToastMessage[];
  pushToast: (msg: Omit<ToastMessage, 'id'>) => void;
  dismissToast: (id: string) => void;
  activeJobs: DurableJob[];
  refreshOverview: (silent?: boolean) => Promise<void>;
  createPost: (input: {
    post_id?: string;
    source_instagram_url: string;
    media_type?: 'REEL' | 'IMAGE' | 'CAROUSEL';
    original_caption?: string;
    caption?: string;
    authorized: boolean;
  }) => Promise<ContentRecord>;
  patchPost: (
    postId: string,
    patch: {
      source_instagram_url?: string;
      caption?: string;
      allowEmptyCaption?: boolean;
      hashtags?: string[];
    },
  ) => Promise<ContentRecord>;
  extractPost: (postId: string, authorized: boolean) => Promise<{ job_id?: string; execution_id?: string }>;
  publishPost: (
    postId: string,
    input: {
      confirm: boolean;
      reviewedRevision: string;
      caption?: string;
      allowEmptyCaption?: boolean;
    },
  ) => Promise<{ job_id?: string; execution_id?: string }>;
  schedulePost: (
    postId: string,
    input: {
      confirm: boolean;
      reviewedRevision: string;
      publish_at: string;
      caption?: string;
      allowEmptyCaption?: boolean;
    },
  ) => Promise<ContentRecord>;
  cancelSchedule: (postId: string) => Promise<ContentRecord>;
  archivePost: (postId: string) => Promise<ContentRecord>;
  retryPost: (postId: string, inspected: boolean, forceReleaseLock?: boolean) => Promise<void>;
  reconcilePost: (
    postId: string,
    input: {
      inspected: boolean;
      resolution: 'CHECK_EXECUTION' | 'MARK_READY' | 'MARK_FAILED' | 'MARK_PUBLISHED' | 'RELEASE_LOCK';
      published_id?: string;
      published_url?: string;
    },
  ) => Promise<void>;
  deletePostMedia: (postId: string, confirm: boolean, reason?: string) => Promise<void>;
  deleteSingleAsset: (assetId: string, confirm: boolean, reason?: string) => Promise<void>;
  deletePostAndMedia: (postId: string, confirm: boolean, reason?: string) => Promise<void>;
  fetchPostDetail: (postId: string) => Promise<PostDetailBundle>;
  fetchExecutionDetail: (execId: string) => Promise<N8nExecutionDetail>;
  testConnections: (forceRefresh?: boolean) => Promise<ServiceConnectionStatus[]>;
  flushSheetsSync: () => Promise<void>;
  updateSettings: (patch: {
    schedulingEnabled?: boolean;
    livePublishEnabled?: boolean;
    liveDeleteEnabled?: boolean;
    reason?: string;
  }) => Promise<void>;
}

const InstaOpsContext = createContext<InstaOpsContextValue | null>(null);

export function InstaOpsProvider({ children }: { children: React.ReactNode }) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [watchedJobs, setWatchedJobs] = useState<Record<string, DurableJob>>({});

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try {
        window.localStorage.setItem('instaops-theme', next);
      } catch {
        // Ignore storage write failure.
      }
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((msg: Omit<ToastMessage, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [{ ...msg, id }, ...prev].slice(0, 5));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const refreshOverview = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const data = await callApi<OverviewResponse & { ok: true }>('/api/overview');
      setOverview(data);
      setLoadError(null);
      setLastSyncedAt(new Date().toISOString());
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unable to fetch InstaOps state';
      setLoadError(msg);
      if (!silent) {
        pushToast({ kind: 'error', title: 'Sync failed', detail: msg });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [pushToast]);

  useEffect(() => {
    let active = true;
    const init = async () => {
      await Promise.resolve();
      if (!active) return;
      try {
        const saved = window.localStorage.getItem('instaops-theme');
        if (saved === 'dark' || saved === 'light') {
          setTheme(saved);
          document.documentElement.setAttribute('data-theme', saved);
        }
      } catch {
        // Ignore storage access failures in strict browser modes.
      }
      await refreshOverview(false);
    };
    void init();
    return () => {
      active = false;
    };
  }, [refreshOverview]);

  const activeJobs = useMemo(() => {
    const merged = new Map<string, DurableJob>();
    for (const j of overview?.jobs ?? []) {
      merged.set(j.job_id, j);
    }
    for (const j of Object.values(watchedJobs)) {
      merged.set(j.job_id, j);
    }
    return Array.from(merged.values()).filter(
      (j) => j.status === 'QUEUED' || j.status === 'RUNNING',
    );
  }, [overview?.jobs, watchedJobs]);

  const watchJob = useCallback(
    async (jobId: string, label: string) => {
      for (let attempt = 0; attempt < 90; attempt++) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const data = await callApi<{ ok: true; job: DurableJob }>(`/api/jobs/${encodeURIComponent(jobId)}`);
          setWatchedJobs((prev) => ({ ...prev, [jobId]: data.job }));
          if (data.job.status === 'COMPLETED') {
            pushToast({ kind: 'success', title: `${label} completed`, detail: `Post ${data.job.post_id}` });
            await refreshOverview(true);
            return;
          }
          if (data.job.status === 'FAILED' || data.job.status === 'OUTCOME_UNKNOWN') {
            pushToast({
              kind: data.job.status === 'OUTCOME_UNKNOWN' ? 'warning' : 'error',
              title: `${label} ${data.job.status === 'OUTCOME_UNKNOWN' ? 'needs verification' : 'failed'}`,
              detail: data.job.error_message || data.job.error_code || 'Check Execution Monitor & Recovery.',
            });
            await refreshOverview(true);
            return;
          }
        } catch {
          // Transient polling error; retry on next tick.
        }
      }
    },
    [pushToast, refreshOverview],
  );

  // Automatic polling while background workflow jobs or in-flight rows exist
  useEffect(() => {
    if (!autoRefresh) return;
    const hasInFlightRows =
      overview?.posts.some((p) => ['EXTRACTING', 'UPLOADING', 'PUBLISHING', 'DELETING'].includes(p.status)) ??
      false;
    const intervalMs = activeJobs.length > 0 || hasInFlightRows ? 6000 : 30000;
    const timer = setInterval(() => {
      void refreshOverview(true);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [autoRefresh, activeJobs.length, overview?.posts, refreshOverview]);

  const createPost = useCallback<InstaOpsContextValue['createPost']>(
    async (input) => {
      const res = await callApi<{ ok: true; post: ContentRecord }>('/api/posts', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      pushToast({ kind: 'success', title: 'Draft created', detail: `${res.post.post_id} added to queue` });
      await refreshOverview(true);
      return res.post;
    },
    [pushToast, refreshOverview],
  );

  const patchPost = useCallback<InstaOpsContextValue['patchPost']>(
    async (postId, patch) => {
      const res = await callApi<{ ok: true; post: ContentRecord }>(`/api/posts/${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      pushToast({ kind: 'success', title: 'Changes saved', detail: `Updated ${postId} (rev ${res.post.revision})` });
      await refreshOverview(true);
      return res.post;
    },
    [pushToast, refreshOverview],
  );

  const extractPost = useCallback<InstaOpsContextValue['extractPost']>(
    async (postId, authorized) => {
      const res = await callApi<{ ok: true; job_id?: string; execution_id?: string }>(
        `/api/posts/${encodeURIComponent(postId)}/extract`,
        { method: 'POST', body: JSON.stringify({ authorized }) },
      );
      pushToast({
        kind: 'info',
        title: 'Extraction started',
        detail: `${postId} queued for extraction & Cloudinary storage`,
      });
      await refreshOverview(true);
      if (res.job_id) void watchJob(res.job_id, 'Extract & Upload');
      return res;
    },
    [pushToast, refreshOverview, watchJob],
  );

  const publishPost = useCallback<InstaOpsContextValue['publishPost']>(
    async (postId, input) => {
      const res = await callApi<{ ok: true; job_id?: string; execution_id?: string }>(
        `/api/posts/${encodeURIComponent(postId)}/publish`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      pushToast({
        kind: 'info',
        title: 'Publish requested',
        detail: `${postId} submitted to Meta Graph API pipeline`,
      });
      await refreshOverview(true);
      if (res.job_id) void watchJob(res.job_id, 'Publish');
      return res;
    },
    [pushToast, refreshOverview, watchJob],
  );

  const schedulePost = useCallback<InstaOpsContextValue['schedulePost']>(
    async (postId, input) => {
      const res = await callApi<{ ok: true; post: ContentRecord }>(
        `/api/posts/${encodeURIComponent(postId)}/schedule`,
        { method: 'POST', body: JSON.stringify(input) },
      );
      pushToast({ kind: 'success', title: 'Post scheduled', detail: `${postId} set to SCHEDULED` });
      await refreshOverview(true);
      return res.post;
    },
    [pushToast, refreshOverview],
  );

  const cancelSchedule = useCallback<InstaOpsContextValue['cancelSchedule']>(
    async (postId) => {
      const res = await callApi<{ ok: true; post: ContentRecord }>(
        `/api/posts/${encodeURIComponent(postId)}/cancel`,
        { method: 'POST' },
      );
      pushToast({ kind: 'success', title: 'Schedule cancelled', detail: `${postId} moved to DRAFT` });
      await refreshOverview(true);
      return res.post;
    },
    [pushToast, refreshOverview],
  );

  const archivePost = useCallback<InstaOpsContextValue['archivePost']>(
    async (postId) => {
      const res = await callApi<{ ok: true; post: ContentRecord }>(
        `/api/posts/${encodeURIComponent(postId)}/archive`,
        { method: 'POST' },
      );
      pushToast({ kind: 'success', title: 'Post archived', detail: postId });
      await refreshOverview(true);
      return res.post;
    },
    [pushToast, refreshOverview],
  );

  const retryPost = useCallback<InstaOpsContextValue['retryPost']>(
    async (postId, inspected, forceReleaseLock = false) => {
      await callApi(`/api/posts/${encodeURIComponent(postId)}/retry`, {
        method: 'POST',
        body: JSON.stringify({ inspected, forceReleaseLock }),
      });
      pushToast({ kind: 'info', title: 'Retry initiated', detail: `${postId} reset for retry` });
      await refreshOverview(true);
    },
    [pushToast, refreshOverview],
  );

  const reconcilePost = useCallback<InstaOpsContextValue['reconcilePost']>(
    async (postId, input) => {
      await callApi(`/api/posts/${encodeURIComponent(postId)}/reconcile`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      pushToast({ kind: 'success', title: 'Reconciliation updated', detail: `${postId} -> ${input.resolution}` });
      await refreshOverview(true);
    },
    [pushToast, refreshOverview],
  );

  const deletePostMedia = useCallback<InstaOpsContextValue['deletePostMedia']>(
    async (postId, confirm, reason) => {
      await callApi(`/api/posts/${encodeURIComponent(postId)}/media`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm, reason }),
      });
      pushToast({ kind: 'success', title: 'Stored media deleted', detail: `Cloudinary assets removed for ${postId}` });
      await refreshOverview(true);
    },
    [pushToast, refreshOverview],
  );

  const deleteSingleAsset = useCallback<InstaOpsContextValue['deleteSingleAsset']>(
    async (assetId, confirm, reason) => {
      await callApi(`/api/media/${encodeURIComponent(assetId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm, reason }),
      });
      pushToast({ kind: 'success', title: 'Asset deleted', detail: assetId });
      await refreshOverview(true);
    },
    [pushToast, refreshOverview],
  );

  const deletePostAndMedia = useCallback<InstaOpsContextValue['deletePostAndMedia']>(
    async (postId, confirm, reason) => {
      await callApi(`/api/posts/${encodeURIComponent(postId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm, reason }),
      });
      pushToast({ kind: 'success', title: 'Post & media deleted', detail: postId });
      await refreshOverview(true);
    },
    [pushToast, refreshOverview],
  );

  const fetchPostDetail = useCallback<InstaOpsContextValue['fetchPostDetail']>(async (postId) => {
    const res = await callApi<PostDetailBundle & { ok: true }>(`/api/posts/${encodeURIComponent(postId)}`);
    return { post: res.post, assets: res.assets, logs: res.logs, eligibility: res.eligibility };
  }, []);

  const fetchExecutionDetail = useCallback<InstaOpsContextValue['fetchExecutionDetail']>(async (execId) => {
    const res = await callApi<{ ok: true; detail: N8nExecutionDetail }>(`/api/executions/${encodeURIComponent(execId)}`);
    return res.detail;
  }, []);

  const testConnections = useCallback<InstaOpsContextValue['testConnections']>(
    async (forceRefresh = true) => {
      const url = forceRefresh ? '/api/connections?refresh=1' : '/api/connections';
      const res = await callApi<{
        ok: true;
        connections: ServiceConnectionStatus[];
        fromCache?: boolean;
        requestId?: string;
      }>(url);
      await refreshOverview(true);
      const cacheTag = res.fromCache ? ' (cached)' : '';
      pushToast({
        kind: 'info',
        title: `Diagnostics finished${cacheTag}`,
        detail: `${res.connections.length} integrations checked${res.requestId ? ` · req ${res.requestId.slice(0, 8)}` : ''}`,
      });
      return res.connections;
    },
    [pushToast, refreshOverview],
  );

  const flushSheetsSync = useCallback<InstaOpsContextValue['flushSheetsSync']>(async () => {
    const res = await callApi<{ ok: true; flushed?: { processed: number; succeeded: number; failed: number } }>(
      '/api/sync',
      { method: 'POST' },
    );
    await refreshOverview(true);
    const f = res.flushed;
    pushToast({
      kind: f && f.failed > 0 ? 'warning' : 'success',
      title: 'Google Sheets Sync Flushed',
      detail: f
        ? `Processed ${f.processed}: ${f.succeeded} synced, ${f.failed} retrying`
        : 'Outbox check complete',
    });
  }, [pushToast, refreshOverview]);

  const updateSettings = useCallback<InstaOpsContextValue['updateSettings']>(
    async (patch) => {
      await callApi('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      pushToast({ kind: 'success', title: 'Settings updated' });
      await refreshOverview(true);
    },
    [pushToast, refreshOverview],
  );

  const value: InstaOpsContextValue = {
    overview,
    loading,
    refreshing,
    loadError,
    lastSyncedAt,
    autoRefresh,
    setAutoRefresh,
    theme,
    toggleTheme,
    toasts,
    pushToast,
    dismissToast,
    activeJobs,
    refreshOverview,
    createPost,
    patchPost,
    extractPost,
    publishPost,
    schedulePost,
    cancelSchedule,
    archivePost,
    retryPost,
    reconcilePost,
    deletePostMedia,
    deleteSingleAsset,
    deletePostAndMedia,
    fetchPostDetail,
    fetchExecutionDetail,
    testConnections,
    flushSheetsSync,
    updateSettings,
  };

  return <InstaOpsContext.Provider value={value}>{children}</InstaOpsContext.Provider>;
}

export function useInstaOps(): InstaOpsContextValue {
  const ctx = useContext(InstaOpsContext);
  if (!ctx) {
    throw new Error('useInstaOps must be used inside <InstaOpsProvider>');
  }
  return ctx;
}
