import { getConfig } from '../config/env';
import { AppError, redactSensitive } from '../errors/codes';
import type { N8nExecutionDetail, N8nExecutionSummary } from '../../types/instaops';

export const ACTIVE_EXECUTION_STATUSES = new Set(['running', 'new', 'waiting']);
export const TERMINAL_EXECUTION_STATUSES = new Set(['success', 'error', 'crashed', 'canceled', 'cancelled']);

interface RawN8nExecution {
  id?: unknown;
  workflowId?: unknown;
  workflowData?: { id?: unknown; name?: unknown };
  status?: unknown;
  finished?: unknown;
  mode?: unknown;
  startedAt?: unknown;
  stoppedAt?: unknown;
  data?: {
    resultData?: {
      lastNodeExecuted?: unknown;
      error?: { message?: unknown };
      runData?: Record<
        string,
        Array<{
          executionTime?: unknown;
          executionStatus?: unknown;
          error?: { message?: unknown };
          data?: { main?: Array<Array<{ json?: unknown }>> };
        }>
      >;
    };
  };
}

export function normalizeN8nExecutionStatus(exec: RawN8nExecution): string {
  const raw = String(exec.status ?? '').trim().toLowerCase();
  const hasError = Boolean(exec.data?.resultData?.error);
  if (raw && raw !== 'unknown') {
    if (
      (exec.finished === true || (Boolean(exec.stoppedAt) && exec.finished !== false)) &&
      ACTIVE_EXECUTION_STATUSES.has(raw)
    ) {
      return hasError ? 'error' : 'success';
    }
    return raw;
  }
  if (hasError) return 'error';
  if (exec.finished === true || (Boolean(exec.stoppedAt) && exec.finished !== false)) return 'success';
  if (exec.finished === false) return 'running';
  return 'unknown';
}

export function isActiveExecution(exec: Pick<N8nExecutionSummary, 'status' | 'finished' | 'stoppedAt'>): boolean {
  const status = exec.status.trim().toLowerCase();
  if (exec.finished === true || (Boolean(exec.stoppedAt) && exec.finished !== false)) return false;
  return ACTIVE_EXECUTION_STATUSES.has(status) || status === 'unknown';
}

async function fetchJsonStrict(
  url: string,
  init: RequestInit,
  timeoutMs = 25_000,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let res: Response;
  let text = '';
  try {
    res = await fetchImpl(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    text = await res.text();
  } catch (err) {
    throw new AppError(
      'DOWNLOADER_UNAVAILABLE',
      `Unable to reach online n8n: ${err instanceof Error ? err.message : String(err)}`,
      { httpStatus: 502 },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError('CONFIGURATION_ERROR', `Online n8n returned non-JSON response (HTTP ${res.status}).`, {
      httpStatus: 502,
    });
  }

  if (!res.ok) {
    const msg =
      typeof parsed === 'object' && parsed !== null && 'message' in parsed
        ? String((parsed as { message?: unknown }).message)
        : `n8n HTTP ${res.status}`;
    throw new AppError('CONFIGURATION_ERROR', `Online n8n error (${res.status}): ${msg.slice(0, 260)}`, {
      httpStatus: res.status >= 400 && res.status < 500 ? res.status : 502,
    });
  }
  return parsed;
}

export async function n8nApiRequest(
  apiPath: string,
  method: 'GET' | 'POST' = 'GET',
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.n8nApiKey) {
    throw new AppError('CONFIGURATION_ERROR', 'N8N_API_KEY is missing.', { httpStatus: 500 });
  }
  return fetchJsonStrict(
    `${cfg.n8nBaseUrl}/api/v1/${apiPath}`,
    {
      method,
      headers: {
        'X-N8N-API-KEY': cfg.n8nApiKey,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: '{}' } : {}),
    },
    25_000,
    fetchImpl,
  );
}

export async function n8nWebhookRequest<T = Record<string, unknown>>(
  webhookPath: string,
  payload: Record<string, unknown>,
  timeoutMs = 35_000,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const cfg = getConfig();
  if (!cfg.n8nWebhookSecret) {
    throw new AppError('CONFIGURATION_ERROR', 'N8N_WEBHOOK_SECRET is missing.', { httpStatus: 500 });
  }
  const data = await fetchJsonStrict(
    `${cfg.n8nBaseUrl}/webhook/${encodeURIComponent(webhookPath)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dashboard-secret': cfg.n8nWebhookSecret,
      },
      body: JSON.stringify(payload),
    },
    timeoutMs,
    fetchImpl,
  );
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') {
    throw new AppError('CONFIGURATION_ERROR', 'Invalid empty response from n8n workflow webhook.', {
      httpStatus: 502,
    });
  }
  const obj = first as Record<string, unknown>;
  if (obj.ok === false) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      String(obj.error ?? obj.message ?? 'n8n workflow rejected request'),
      { httpStatus: 422 },
    );
  }
  return obj as T;
}

/** Query latest executions across all configured InstaOps v2 workflows on online n8n. */
export async function listConfiguredWorkflowExecutions(
  limitPerWorkflow = 25,
  fetchImpl: typeof fetch = fetch,
): Promise<N8nExecutionSummary[]> {
  const cfg = getConfig();
  const targets: Array<{ id: string; label: string }> = [
    { id: cfg.workflows.extractId, label: 'W01 Extract & Upload' },
    { id: cfg.workflows.publishId, label: 'W02 Publish Content' },
    { id: cfg.workflows.scheduleId, label: 'W03 Schedule Manager' },
    { id: cfg.workflows.contentId, label: 'W04 Content Management' },
    { id: cfg.workflows.recoveryId, label: 'W05 Recovery & Monitoring' },
  ].filter((t) => Boolean(t.id));

  if (!targets.length) return [];

  const responses = await Promise.allSettled(
    targets.map(async (t) => {
      const res = (await n8nApiRequest(
        `executions?workflowId=${encodeURIComponent(t.id)}&limit=${limitPerWorkflow}`,
        'GET',
        fetchImpl,
      )) as { data?: RawN8nExecution[] };
      return (res.data ?? []).map((e): N8nExecutionSummary => {
        const status = normalizeN8nExecutionStatus(e);
        const startedAt = String(e.startedAt ?? '');
        const stoppedAt = e.stoppedAt ? String(e.stoppedAt) : null;
        const durationMs =
          startedAt && stoppedAt && Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(stoppedAt))
            ? Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt))
            : null;
        return {
          id: String(e.id ?? ''),
          workflowId: String(e.workflowId ?? t.id),
          workflowName: t.label,
          status,
          mode: String(e.mode ?? 'unknown'),
          startedAt,
          stoppedAt,
          finished: e.finished === true || TERMINAL_EXECUTION_STATUSES.has(status),
          durationMs,
        };
      });
    }),
  );

  const merged: N8nExecutionSummary[] = [];
  for (const item of responses) {
    if (item.status === 'fulfilled') merged.push(...item.value);
  }
  return merged.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export async function getExecutionDetail(
  executionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<N8nExecutionDetail> {
  const cfg = getConfig();
  const allowedIds = new Set(
    [
      cfg.workflows.extractId,
      cfg.workflows.publishId,
      cfg.workflows.scheduleId,
      cfg.workflows.contentId,
      cfg.workflows.recoveryId,
    ].filter(Boolean),
  );
  const raw = (await n8nApiRequest(
    `executions/${encodeURIComponent(executionId)}?includeData=true`,
    'GET',
    fetchImpl,
  )) as RawN8nExecution;

  const wfId = String(raw.workflowId ?? raw.workflowData?.id ?? '');
  if (allowedIds.size > 0 && !allowedIds.has(wfId)) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Execution does not belong to any configured InstaOps v2 workflow.', {
      httpStatus: 403,
    });
  }

  const rd = raw.data?.resultData ?? {};
  const runData = rd.runData ?? {};
  const nodes = Object.entries(runData).flatMap(([name, items]) =>
    (items ?? []).map((n, i) => ({
      name,
      attempt: i + 1,
      durationMs: typeof n.executionTime === 'number' ? n.executionTime : null,
      status: n.error ? 'error' : String(n.executionStatus ?? 'success').toLowerCase(),
      error: String(redactSensitive(n.error?.message ?? '')),
    })),
  );

  const reports: Record<string, unknown> = {};
  for (const [name, items] of Object.entries(runData)) {
    if (name.startsWith('REPORT |') || name.startsWith('OUTPUT |')) {
      reports[name] = redactSensitive(items?.at(-1)?.data?.main?.[0]?.map((x) => x.json));
    }
  }

  const status = normalizeN8nExecutionStatus(raw);
  const startedAt = String(raw.startedAt ?? '');
  const stoppedAt = raw.stoppedAt ? String(raw.stoppedAt) : null;
  const durationMs =
    startedAt && stoppedAt && Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(stoppedAt))
      ? Math.max(0, Date.parse(stoppedAt) - Date.parse(startedAt))
      : null;

  return {
    id: String(raw.id ?? executionId),
    workflowId: wfId,
    workflowName: String(raw.workflowData?.name ?? ''),
    status,
    mode: String(raw.mode ?? 'unknown'),
    startedAt,
    stoppedAt,
    finished: raw.finished === true || TERMINAL_EXECUTION_STATUSES.has(status),
    durationMs,
    lastNode: String(rd.lastNodeExecuted ?? ''),
    errorMessage: String(redactSensitive(rd.error?.message ?? '')),
    nodes,
    reports,
  };
}

export async function getWorkflowMetadata(
  workflowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; name: string; active: boolean; nodesCount: number }> {
  const wf = (await n8nApiRequest(`workflows/${encodeURIComponent(workflowId)}`, 'GET', fetchImpl)) as {
    id?: string;
    name?: string;
    active?: boolean;
    nodes?: unknown[];
  };
  return {
    id: String(wf.id ?? workflowId),
    name: String(wf.name ?? ''),
    active: Boolean(wf.active),
    nodesCount: Array.isArray(wf.nodes) ? wf.nodes.length : 0,
  };
}

export async function setWorkflowActiveState(
  workflowId: string,
  active: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  await n8nApiRequest(
    `workflows/${encodeURIComponent(workflowId)}/${active ? 'activate' : 'deactivate'}`,
    'POST',
    fetchImpl,
  );
  const verified = await getWorkflowMetadata(workflowId, fetchImpl);
  return verified.active;
}
