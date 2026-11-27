import { getConfig } from '../config/env';
import { AppError, redactSensitive } from '../errors/codes';
import type {
  DiagnosticState,
  N8nExecutionDetail,
  N8nExecutionSummary,
  WorkflowIntegrityReport,
} from '../../types/instaops';
import { inspectWorkflowGraph, type WorkflowJson } from './workflow-safety';

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

export interface ClassifiedDiagnosticError {
  diagnosticState: DiagnosticState;
  httpStatus: number | null;
  errorCode: string;
  detail: string;
}

export function classifyDiagnosticError(err: unknown): ClassifiedDiagnosticError {
  if (err instanceof AppError) {
    const details = (err.details ?? {}) as Record<string, unknown>;
    const rawState = details.diagnosticState as DiagnosticState | undefined;
    const httpStatus = typeof details.httpStatus === 'number' ? details.httpStatus : err.httpStatus ?? null;
    if (rawState) {
      return {
        diagnosticState: rawState,
        httpStatus,
        errorCode: err.code,
        detail: err.message,
      };
    }
    if (httpStatus === 401 || httpStatus === 403 || err.code === 'INSTAGRAM_AUTH_FAILED' || err.code === 'DOWNLOADER_AUTH_FAILED') {
      return { diagnosticState: 'auth_rejected', httpStatus, errorCode: err.code, detail: err.message };
    }
    if (httpStatus === 404) {
      return { diagnosticState: 'webhook_unavailable', httpStatus, errorCode: err.code, detail: err.message };
    }
    if (/timed out|timeout|aborted|aborterror/i.test(err.message)) {
      return { diagnosticState: 'timeout', httpStatus, errorCode: err.code, detail: err.message };
    }
    if (/non-json|invalid.*response/i.test(err.message)) {
      return { diagnosticState: 'invalid_response', httpStatus, errorCode: err.code, detail: err.message };
    }
    return { diagnosticState: 'provider_error', httpStatus, errorCode: err.code, detail: err.message };
  }

  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out|timeout|aborted|aborterror/i.test(msg)) {
    return { diagnosticState: 'timeout', httpStatus: null, errorCode: 'TIMEOUT', detail: msg };
  }
  return { diagnosticState: 'provider_error', httpStatus: null, errorCode: 'UNKNOWN_ERROR', detail: msg };
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

async function fetchJsonWithStatus(
  url: string,
  init: RequestInit,
  timeoutMs = 25_000,
  fetchImpl: typeof fetch = fetch,
  context: 'api' | 'webhook' = 'api',
): Promise<{ status: number; latencyMs: number; parsed: unknown }> {
  const t0 = Date.now();
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
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout =
      (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
      /timed out|timeout|aborted/i.test(msg);
    throw new AppError(
      'DOWNLOADER_UNAVAILABLE',
      isTimeout
        ? `Timed out waiting for online n8n after ${Math.round(timeoutMs / 1000)}s: ${msg}`
        : `Unable to reach online n8n: ${msg}`,
      {
        httpStatus: isTimeout ? 504 : 502,
        details: {
          diagnosticState: isTimeout ? 'timeout' : 'provider_error',
          httpStatus: isTimeout ? 504 : null,
        },
      },
    );
  }

  const latencyMs = Date.now() - t0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const isAuthHtml = res.status === 401 || res.status === 403;
    const isNotFound = res.status === 404;
    const state: DiagnosticState = isAuthHtml
      ? 'auth_rejected'
      : isNotFound && context === 'webhook'
        ? 'webhook_unavailable'
        : 'invalid_response';
    throw new AppError('CONFIGURATION_ERROR', `Online n8n returned non-JSON response (HTTP ${res.status}).`, {
      httpStatus: res.status >= 400 ? res.status : 502,
      details: { diagnosticState: state, httpStatus: res.status },
    });
  }

  if (!res.ok) {
    const msg =
      typeof parsed === 'object' && parsed !== null && ('message' in parsed || 'error' in parsed)
        ? String((parsed as { message?: unknown; error?: unknown }).message ?? (parsed as { error?: unknown }).error)
        : `n8n HTTP ${res.status}`;
    const state: DiagnosticState =
      res.status === 401 || res.status === 403
        ? 'auth_rejected'
        : res.status === 404 && context === 'webhook'
          ? 'webhook_unavailable'
          : res.status === 504
            ? 'timeout'
            : 'provider_error';
    throw new AppError('CONFIGURATION_ERROR', `Online n8n error (${res.status}): ${msg.slice(0, 260)}`, {
      httpStatus: res.status >= 400 && res.status < 500 ? res.status : 502,
      details: { diagnosticState: state, httpStatus: res.status },
    });
  }

  return { status: res.status, latencyMs, parsed };
}

export async function n8nApiRequest(
  apiPath: string,
  method: 'GET' | 'POST' = 'GET',
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg.n8nApiKey) {
    throw new AppError('CONFIGURATION_ERROR', 'N8N_API_KEY is missing.', {
      httpStatus: 500,
      details: { diagnosticState: 'not_configured', httpStatus: null },
    });
  }
  const { parsed } = await fetchJsonWithStatus(
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
    'api',
  );
  return parsed;
}

export async function n8nWebhookRequestDetailed<T = Record<string, unknown>>(
  webhookPath: string,
  payload: Record<string, unknown>,
  timeoutMs = 35_000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; latencyMs: number; data: T }> {
  const cfg = getConfig();
  if (!cfg.n8nWebhookSecret) {
    throw new AppError('CONFIGURATION_ERROR', 'N8N_WEBHOOK_SECRET is missing.', {
      httpStatus: 500,
      details: { diagnosticState: 'not_configured', httpStatus: null },
    });
  }
  const { status, latencyMs, parsed } = await fetchJsonWithStatus(
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
    'webhook',
  );
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== 'object') {
    throw new AppError('CONFIGURATION_ERROR', 'Invalid empty response from n8n workflow webhook.', {
      httpStatus: 502,
      details: { diagnosticState: 'invalid_response', httpStatus: status },
    });
  }
  const obj = first as Record<string, unknown>;
  if (obj.ok === false) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      String(obj.error ?? obj.message ?? 'n8n workflow rejected request'),
      {
        httpStatus: 422,
        details: { diagnosticState: 'provider_error', httpStatus: status },
      },
    );
  }
  return { status, latencyMs, data: obj as T };
}

export async function n8nWebhookRequest<T = Record<string, unknown>>(
  webhookPath: string,
  payload: Record<string, unknown>,
  timeoutMs = 35_000,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await n8nWebhookRequestDetailed<T>(webhookPath, payload, timeoutMs, fetchImpl);
  return res.data;
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

const EXPECTED_WORKFLOW_LIMITS: Record<
  'W01' | 'W02' | 'W03' | 'W04' | 'W05',
  { maxNodes: number; expectedPath?: 'extractPath' | 'publishPath' | 'contentPath' | 'recoveryPath' }
> = {
  W01: { maxNodes: 65, expectedPath: 'extractPath' },
  W02: { maxNodes: 130, expectedPath: 'publishPath' },
  W03: { maxNodes: 35 },
  W04: { maxNodes: 75, expectedPath: 'contentPath' },
  W05: { maxNodes: 65, expectedPath: 'recoveryPath' },
};

/**
 * Inspects all configured W01-W05 remote workflows on online n8n for active state,
 * duplicate-canvas imports (e.g. 430-node combined imports), broken connections, legacy IF v1 schemas,
 * unbound credential placeholders, and conflicting active webhook paths across workspace workflows.
 */
export async function verifyRemoteWorkflowsIntegrity(
  fetchImpl: typeof fetch = fetch,
): Promise<{
  authenticated: boolean;
  httpStatus: number | null;
  authError: string;
  reports: WorkflowIntegrityReport[];
}> {
  const cfg = getConfig();
  const entries: Array<{ role: 'W01' | 'W02' | 'W03' | 'W04' | 'W05'; id: string; required: boolean }> = [
    { role: 'W01', id: cfg.workflows.extractId, required: true },
    { role: 'W02', id: cfg.workflows.publishId, required: true },
    { role: 'W03', id: cfg.workflows.scheduleId, required: false },
    { role: 'W04', id: cfg.workflows.contentId, required: true },
    { role: 'W05', id: cfg.workflows.recoveryId, required: true },
  ];

  if (!cfg.n8nApiKey) {
    return {
      authenticated: false,
      httpStatus: null,
      authError: 'Missing N8N_API_KEY in server environment.',
      reports: entries.map((e) => ({
        role: e.role,
        workflowId: e.id,
        configured: Boolean(e.id),
        reachable: false,
        name: '',
        active: false,
        required: e.required,
        nodeCount: 0,
        expectedMaxNodes: EXPECTED_WORKFLOW_LIMITS[e.role].maxNodes,
        webhookPaths: [],
        hasWebhookAuth: false,
        hasLegacyIfSchema: false,
        hasDuplicateNodeNames: false,
        hasBrokenConnections: false,
        hasUnboundPlaceholders: false,
        hasDuplicateCanvasSuspected: false,
        conflictingActiveWorkflowIds: [],
        disabledCronTriggers: true,
        integrityOk: false,
        errors: ['N8N_API_KEY is missing'],
        warnings: [],
      })),
    };
  }

  // Query full workflow list to spot active workflows sharing the same webhook path
  const pathToActiveIds = new Map<string, string[]>();
  let listAuthError: ClassifiedDiagnosticError | null = null;
  try {
    const listRes = (await n8nApiRequest('workflows?limit=100', 'GET', fetchImpl)) as {
      data?: Array<Partial<WorkflowJson> & { id?: string; active?: boolean }>;
    };
    for (const item of listRes.data ?? []) {
      if (!item || !item.active || !Array.isArray(item.nodes)) continue;
      for (const n of item.nodes) {
        if (n.type === 'n8n-nodes-base.webhook') {
          const wp = String(n.parameters?.path ?? '').trim();
          if (wp && item.id) {
            const arr = pathToActiveIds.get(wp) ?? [];
            arr.push(String(item.id));
            pathToActiveIds.set(wp, arr);
          }
        }
      }
    }
  } catch (err) {
    const cls = classifyDiagnosticError(err);
    if (cls.httpStatus === 401 || cls.httpStatus === 403 || cls.diagnosticState === 'timeout') {
      listAuthError = cls;
    }
  }

  const reports = await Promise.all(
    entries.map(async (entry): Promise<WorkflowIntegrityReport> => {
      const spec = EXPECTED_WORKFLOW_LIMITS[entry.role];
      const baseReport: WorkflowIntegrityReport = {
        role: entry.role,
        workflowId: entry.id,
        configured: Boolean(entry.id),
        reachable: false,
        name: '',
        active: false,
        required: entry.required,
        nodeCount: 0,
        expectedMaxNodes: spec.maxNodes,
        webhookPaths: [],
        hasWebhookAuth: true,
        hasLegacyIfSchema: false,
        hasDuplicateNodeNames: false,
        hasBrokenConnections: false,
        hasUnboundPlaceholders: false,
        hasDuplicateCanvasSuspected: false,
        conflictingActiveWorkflowIds: [],
        disabledCronTriggers: true,
        integrityOk: false,
        errors: [],
        warnings: [],
      };

      if (!entry.id) {
        baseReport.errors.push(`${entry.role} workflow ID is not configured.`);
        return baseReport;
      }

      if (listAuthError && (listAuthError.httpStatus === 401 || listAuthError.httpStatus === 403)) {
        baseReport.errors.push(listAuthError.detail);
        return baseReport;
      }

      try {
        const wf = (await n8nApiRequest(`workflows/${encodeURIComponent(entry.id)}`, 'GET', fetchImpl)) as Partial<WorkflowJson> & {
          id?: string;
          name?: string;
          active?: boolean;
        };
        const name = String(wf.name ?? '');
        const active = Boolean(wf.active);
        const hasNodesArray = Array.isArray(wf.nodes);
        const nodesCount = hasNodesArray ? wf.nodes!.length : 0;

        baseReport.reachable = true;
        baseReport.name = name;
        baseReport.active = active;
        baseReport.nodeCount = nodesCount;

        if (hasNodesArray && nodesCount === 0) {
          baseReport.errors.push(`${entry.role} has 0 nodes (empty canvas).`);
          return baseReport;
        }

        if (hasNodesArray && wf.connections) {
          const inspection = inspectWorkflowGraph({
            id: entry.id,
            name,
            active,
            nodes: wf.nodes!,
            connections: wf.connections,
          });
          baseReport.webhookPaths = inspection.webhookPaths;
          baseReport.hasWebhookAuth = inspection.hasWebhookAuth;
          baseReport.hasLegacyIfSchema = inspection.hasLegacyIfSchema;
          baseReport.hasDuplicateNodeNames = inspection.hasDuplicateNodeNames || inspection.hasDuplicateNodeIds;
          baseReport.hasBrokenConnections = inspection.hasBrokenConnections;
          baseReport.hasUnboundPlaceholders = inspection.unboundPlaceholders.length > 0;
          baseReport.disabledCronTriggers = inspection.disabledCronTriggers;

          if (
            nodesCount > spec.maxNodes ||
            inspection.triggerCount !== 1 ||
            inspection.unreachableNodeCount > 0 ||
            inspection.hasDuplicateNodeNames ||
            inspection.hasDuplicateNodeIds
          ) {
            baseReport.hasDuplicateCanvasSuspected =
              nodesCount > spec.maxNodes ||
              inspection.triggerCount > 1 ||
              inspection.unreachableNodeCount > 0 ||
              inspection.hasDuplicateNodeNames;
          }

          if (spec.expectedPath) {
            const wantPath = cfg.workflows[spec.expectedPath];
            if (!inspection.webhookPaths.includes(wantPath)) {
              baseReport.errors.push(
                `${entry.role} missing expected webhook path "${wantPath}" (found: ${inspection.webhookPaths.join(', ') || 'none'}).`,
              );
            }
          }

          for (const wp of inspection.webhookPaths) {
            const owners = (pathToActiveIds.get(wp) ?? []).filter((oid) => oid !== entry.id);
            if (owners.length > 0) {
              baseReport.conflictingActiveWorkflowIds.push(...owners);
              baseReport.errors.push(
                `${entry.role} shares active webhook path "${wp}" with conflicting workflow(s): ${owners.join(', ')}.`,
              );
            }
          }

          if (inspection.unboundPlaceholders.length > 0) {
            baseReport.errors.push(
              `${entry.role} still has unbound placeholder credentials: ${inspection.unboundPlaceholders.join(', ')}.`,
            );
          }

          if (nodesCount > spec.maxNodes) {
            baseReport.errors.push(
              `${entry.role} has ${nodesCount} nodes (expected <= ${spec.maxNodes}); likely double-imported onto an existing canvas.`,
            );
          }

          if (entry.role === 'W03' && !inspection.disabledCronTriggers && active) {
            baseReport.warnings.push('W03 Schedule Trigger is enabled and workflow is active; confirm scheduling is intended.');
          }

          baseReport.errors.push(...inspection.errors);
        }

        if (entry.required && !active) {
          baseReport.warnings.push(`${entry.role} is imported cleanly but currently inactive in n8n.`);
        }

        baseReport.integrityOk = baseReport.errors.length === 0;
        return baseReport;
      } catch (err) {
        const cls = classifyDiagnosticError(err);
        baseReport.errors.push(cls.detail);
        return baseReport;
      }
    }),
  );

  const anyAuthSuccess = reports.some((r) => r.reachable);
  const firstAuthErr = reports.find((r) => r.configured && !r.reachable)?.errors[0] ?? listAuthError?.detail ?? '';
  return {
    authenticated: anyAuthSuccess,
    httpStatus: listAuthError?.httpStatus ?? (anyAuthSuccess ? 200 : null),
    authError: anyAuthSuccess ? '' : firstAuthErr || 'Unable to authenticate n8n REST API.',
    reports,
  };
}
