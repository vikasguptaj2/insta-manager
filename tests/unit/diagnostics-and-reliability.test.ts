import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getConfig, validateConfig } from '../../lib/config/env';
import { LocalLockStore, resetLockStoreForTest } from '../../lib/jobs/lock-store';
import { classifyDiagnosticError, verifyRemoteWorkflowsIntegrity } from '../../lib/n8n/client';
import {
  inspectWorkflowGraph,
  verifyWorkflowExport,
  type WorkflowJson,
} from '../../lib/n8n/workflow-safety';
import {
  getReadinessDiagnostics,
  resetDiagnosticsCacheForTest,
  updateRuntimeSettings,
} from '../../lib/service';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENV_KEYS = [
  'DEMO_MODE',
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'N8N_BASE_URL',
  'N8N_API_KEY',
  'N8N_WEBHOOK_SECRET',
  'N8N_DIAGNOSTIC_TIMEOUT_MS',
  'N8N_EXTRACT_WORKFLOW_ID',
  'N8N_PUBLISH_WORKFLOW_ID',
  'N8N_SCHEDULE_WORKFLOW_ID',
  'N8N_CONTENT_WORKFLOW_ID',
  'N8N_RECOVERY_WORKFLOW_ID',
  'DOWNLOADER_BASE_URL',
  'DOWNLOADER_API_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'INSTAGRAM_USER_ID',
  'ATOMIC_LOCK_PROVIDER',
  'SCHEDULING_ENABLED',
  'LIVE_PUBLISH_ENABLED',
  'LIVE_DELETE_ENABLED',
] as const;

const savedEnv: Partial<Record<string, string | undefined>> = {};

function setTestEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    if (key in overrides) {
      const val = overrides[key];
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}

function restoreEnv(): void {
  for (const key of Object.keys(savedEnv)) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
    delete savedEnv[key];
  }
}

function loadWorkflowJson(rel: string): WorkflowJson {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')) as WorkflowJson;
}

function bindRemoteCreds(wf: WorkflowJson): WorkflowJson {
  return {
    ...wf,
    nodes: wf.nodes.map((node) => {
      if (!node.credentials) return node;
      const nextCreds: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.credentials)) {
        const rec = v && typeof v === 'object' ? (v as { id?: string; name?: string }) : null;
        if (rec?.id?.startsWith('CONFIGURE_')) {
          nextCreds[k] = { ...rec, id: `live_${rec.id.toLowerCase()}` };
        } else {
          nextCreds[k] = v;
        }
      }
      return { ...node, credentials: nextCreds };
    }),
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseLiveEnv(extra: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}): void {
  resetDiagnosticsCacheForTest();
  resetLockStoreForTest();
  setTestEnv({
    DEMO_MODE: 'false',
    SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
    NEXT_PUBLIC_SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
    SUPABASE_ANON_KEY: 'anon_test_key',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon_test_key',
    SUPABASE_SERVICE_ROLE_KEY: 'srv_test_role_key',
    N8N_BASE_URL: 'https://137.23.61.127.sslip.io',
    N8N_API_KEY: 'n8n_api_test_key',
    N8N_WEBHOOK_SECRET: 'wh_secret_test_value_1234',
    N8N_DIAGNOSTIC_TIMEOUT_MS: '45000',
    N8N_EXTRACT_WORKFLOW_ID: 'piXQdqGkfekyiDqN',
    N8N_PUBLISH_WORKFLOW_ID: 'tFdUdrvmm4zBSpQx',
    N8N_SCHEDULE_WORKFLOW_ID: 'ECgWasiSsSkkhV4Z',
    N8N_CONTENT_WORKFLOW_ID: 'IgVt3iG684ChAPqG',
    N8N_RECOVERY_WORKFLOW_ID: 'kAu6IU5LZ6tRUoJt',
    DOWNLOADER_BASE_URL: 'https://ig-dowloader-nnnn.vercel.app',
    DOWNLOADER_API_KEY: 'dl_api_test_key',
    CLOUDINARY_CLOUD_NAME: 'djkkknb9k',
    INSTAGRAM_USER_ID: '17841453414532595',
    ATOMIC_LOCK_PROVIDER: 'supabase',
    SCHEDULING_ENABLED: 'false',
    LIVE_PUBLISH_ENABLED: 'false',
    LIVE_DELETE_ENABLED: 'false',
    ...extra,
  });
}

afterEach(() => {
  resetDiagnosticsCacheForTest();
  resetLockStoreForTest();
  restoreEnv();
});

describe('Diagnostics, Env Validation, Workflow Integrity & Lock Lease Safety', () => {
  it('fixes empty SUPABASE_URL fallback, bounds N8N_DIAGNOSTIC_TIMEOUT_MS, and flags duplicate workflow IDs', () => {
    const cfg = getConfig({
      SUPABASE_URL: '',
      NEXT_PUBLIC_SUPABASE_URL: 'https://custom.supabase.co',
      SUPABASE_ANON_KEY: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'pub_anon_1',
      N8N_DIAGNOSTIC_TIMEOUT_MS: '999999',
    });
    assert.equal(cfg.supabaseUrl, 'https://custom.supabase.co');
    assert.equal(cfg.supabaseAnonKey, 'pub_anon_1');
    assert.equal(cfg.diagnosticTimeoutMs, 120_000);

    const low = getConfig({ N8N_DIAGNOSTIC_TIMEOUT_MS: '500' });
    assert.equal(low.diagnosticTimeoutMs, 5_000);
    assert.equal(getConfig({}).diagnosticTimeoutMs, 45_000);

    baseLiveEnv({ N8N_PUBLISH_WORKFLOW_ID: 'piXQdqGkfekyiDqN' });
    const dupReport = validateConfig(getConfig());
    assert.equal(dupReport.valid, false);
    assert.ok(dupReport.errors.some((e) => /duplicates workflow id/i.test(e)));
  });

  it('validates W00..W05 workflow exports cleanly and catches broken graphs / duplicate names / legacy schemas', () => {
    const map: Array<['W00' | 'W01' | 'W02' | 'W03' | 'W04' | 'W05', string]> = [
      ['W00', 'n8n/workflows/00-manual-credential-check.json'],
      ['W01', 'n8n/workflows/01-extract-upload.json'],
      ['W02', 'n8n/workflows/02-publish-content.json'],
      ['W03', 'n8n/workflows/03-scheduled-runner.json'],
      ['W04', 'n8n/workflows/04-content-management.json'],
      ['W05', 'n8n/workflows/05-recovery-reconciliation.json'],
    ];
    for (const [role, rel] of map) {
      const wf = loadWorkflowJson(rel);
      const res = verifyWorkflowExport(role, wf);
      assert.equal(res.valid, true, `${role} errors: ${res.errors.join('; ')}`);
    }

    const broken: WorkflowJson = {
      name: 'Broken Duplicate Canvas',
      active: false,
      nodes: [
        {
          id: 'n1',
          name: 'WEBHOOK | A',
          type: 'n8n-nodes-base.webhook',
          parameters: { path: 'a' },
        },
        {
          id: 'n1',
          name: 'IF | Legacy',
          type: 'n8n-nodes-base.if',
          typeVersion: 1,
          parameters: { conditions: { boolean: [{ value1: true, value2: true }] } },
        },
      ],
      connections: {
        'WEBHOOK | A': { main: [[{ node: 'DOES_NOT_EXIST', type: 'main', index: 0 }]] },
      },
    };
    const insp = inspectWorkflowGraph(broken);
    assert.equal(insp.hasDuplicateNodeIds, true);
    assert.equal(insp.hasLegacyIfSchema, true);
    assert.equal(insp.hasBrokenConnections, true);
    assert.equal(insp.hasWebhookAuth, false);
    assert.ok(insp.unreachableNodeCount >= 1);
  });

  it('verifyRemoteWorkflowsIntegrity flags duplicate-canvas imports, conflicting active webhooks & unbound placeholders while allowing W03 paused', async () => {
    baseLiveEnv();
    const w01 = loadWorkflowJson('n8n/workflows/01-extract-upload.json');
    const w02 = bindRemoteCreds(loadWorkflowJson('n8n/workflows/02-publish-content.json'));
    const w03 = bindRemoteCreds(loadWorkflowJson('n8n/workflows/03-scheduled-runner.json'));
    const w04 = bindRemoteCreds(loadWorkflowJson('n8n/workflows/04-content-management.json'));
    const w05 = bindRemoteCreds(loadWorkflowJson('n8n/workflows/05-recovery-reconciliation.json'));

    // Simulate W01 having duplicate extra trigger + 150 nodes + CONFIGURE_WEBHOOK placeholder
    const bloatedW01: WorkflowJson = {
      ...w01,
      id: 'piXQdqGkfekyiDqN',
      active: true,
      nodes: [
        ...w01.nodes,
        ...Array.from({ length: 120 }, (_, i) => ({
          id: `dup_${i}`,
          name: `DUP_${i}`,
          type: i === 0 ? 'n8n-nodes-base.webhook' : 'n8n-nodes-base.noOp',
          parameters: i === 0 ? { path: 'instaops-extract-v1', authentication: 'headerAuth' } : {},
          credentials: i === 0 ? { httpHeaderAuth: { id: 'CONFIGURE_WEBHOOK', name: 'Webhook' } } : undefined,
        })),
      ],
    };

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/v1/workflows?limit=100')) {
        return jsonRes({
          data: [
            {
              id: 'OLD_CONFLICT_WF',
              active: true,
              nodes: [
                {
                  id: 'old_w',
                  name: 'WH',
                  type: 'n8n-nodes-base.webhook',
                  parameters: { path: 'instaops-publish-v1' },
                },
              ],
            },
            { id: 'tFdUdrvmm4zBSpQx', active: true, nodes: w02.nodes },
          ],
        });
      }
      if (url.endsWith('/workflows/piXQdqGkfekyiDqN')) return jsonRes(bloatedW01);
      if (url.endsWith('/workflows/tFdUdrvmm4zBSpQx')) return jsonRes({ ...w02, id: 'tFdUdrvmm4zBSpQx', active: true });
      if (url.endsWith('/workflows/ECgWasiSsSkkhV4Z')) return jsonRes({ ...w03, id: 'ECgWasiSsSkkhV4Z', active: false });
      if (url.endsWith('/workflows/IgVt3iG684ChAPqG')) return jsonRes({ ...w04, id: 'IgVt3iG684ChAPqG', active: true });
      if (url.endsWith('/workflows/kAu6IU5LZ6tRUoJt')) return jsonRes({ ...w05, id: 'kAu6IU5LZ6tRUoJt', active: true });
      return jsonRes({}, 404);
    };

    const integrity = await verifyRemoteWorkflowsIntegrity(mockFetch);
    assert.equal(integrity.authenticated, true);
    const rep1 = integrity.reports.find((r) => r.role === 'W01');
    const rep2 = integrity.reports.find((r) => r.role === 'W02');
    const rep3 = integrity.reports.find((r) => r.role === 'W03');

    assert.equal(rep1?.hasDuplicateCanvasSuspected, true);
    assert.equal(rep1?.hasUnboundPlaceholders, true);
    assert.equal(rep1?.integrityOk, false);
    assert.ok(rep2?.conflictingActiveWorkflowIds.includes('OLD_CONFLICT_WF'));
    assert.equal(rep2?.integrityOk, false);
    assert.equal(rep3?.active, false);
    assert.equal(rep3?.integrityOk, true);
  });

  it('never reports n8nEnvAccessOk=true when W05 fails (403/404/timeout/invalid) and marks downstream providers not_tested', async () => {
    baseLiveEnv();
    const cleanWfs: Record<string, WorkflowJson> = {
      piXQdqGkfekyiDqN: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/01-extract-upload.json')), id: 'piXQdqGkfekyiDqN', active: true },
      tFdUdrvmm4zBSpQx: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/02-publish-content.json')), id: 'tFdUdrvmm4zBSpQx', active: true },
      ECgWasiSsSkkhV4Z: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/03-scheduled-runner.json')), id: 'ECgWasiSsSkkhV4Z', active: false },
      IgVt3iG684ChAPqG: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/04-content-management.json')), id: 'IgVt3iG684ChAPqG', active: true },
      kAu6IU5LZ6tRUoJt: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/05-recovery-reconciliation.json')), id: 'kAu6IU5LZ6tRUoJt', active: true },
    };

    const buildFetch = (w05Mode: '403' | '404' | 'timeout' | 'nonjson'): typeof fetch => {
      return async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/rpc/instaops_verify_health_and_rpc')) {
          return jsonRes([{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, detail: 'ok' }]);
        }
        if (url.includes('/rest/v1/instaops_accounts')) return jsonRes([{ ig_user_id: '17841453414532595', enabled: true }]);
        if (url.includes('/rest/v1/instaops_posts')) return jsonRes([]);
        if (url.includes('/rpc/instaops_get_runtime_settings')) {
          return jsonRes([{ live_publish_enabled: false, live_delete_enabled: false, scheduling_enabled: false }]);
        }
        if (url.endsWith('/api/health')) return jsonRes({ ok: true });
        if (url.endsWith('/api/n8n/resolve')) return jsonRes({ ok: false, error: 'URL missing' }, 400);
        if (url.endsWith('/api/v1/workflows?limit=100')) {
          return jsonRes({ data: Object.values(cleanWfs) });
        }
        for (const [id, wf] of Object.entries(cleanWfs)) {
          if (url.endsWith(`/workflows/${id}`)) return jsonRes(wf);
        }
        if (url.includes('/webhook/instaops-recovery-v1')) {
          if (w05Mode === '403') return jsonRes({ message: 'Forbidden' }, 403);
          if (w05Mode === '404') return jsonRes({ message: 'Not active' }, 404);
          if (w05Mode === 'nonjson') return new Response('<html>Gateway Error</html>', { status: 502 });
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'TimeoutError';
          throw err;
        }
        return jsonRes({}, 404);
      };
    };

    const cases: Array<['403' | '404' | 'timeout' | 'nonjson', string]> = [
      ['403', 'auth_rejected'],
      ['404', 'webhook_unavailable'],
      ['timeout', 'timeout'],
      ['nonjson', 'invalid_response'],
    ];

    for (const [mode, expectedState] of cases) {
      const diag = await getReadinessDiagnostics(buildFetch(mode));
      assert.equal(diag.readiness.n8nEnvAccessOk, false, `${mode}: n8nEnvAccessOk must be false`);
      assert.equal(diag.readiness.n8nDiagnosticStatus, expectedState, `${mode}: diagnosticState mismatch`);
      assert.equal(diag.readiness.webhookAuthVerified, false, `${mode}: webhook probe failed`);
      const cld = diag.connections.find((c) => c.id === 'cloudinary');
      const ig = diag.connections.find((c) => c.id === 'instagram');
      const sheets = diag.connections.find((c) => c.id === 'sheets');
      assert.equal(cld?.diagnosticState, 'not_tested');
      assert.equal(ig?.diagnosticState, 'not_tested');
      assert.equal(sheets?.diagnosticState, 'not_tested');
    }

    assert.equal(classifyDiagnosticError(new Error('Request timed out')).diagnosticState, 'timeout');
  });

  it('coalesces concurrent probes, caches valid default-fetch diagnostics briefly, and bypasses cache on forceRefresh', async () => {
    baseLiveEnv();
    resetDiagnosticsCacheForTest();
    const cleanWfs: Record<string, WorkflowJson> = {
      piXQdqGkfekyiDqN: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/01-extract-upload.json')), id: 'piXQdqGkfekyiDqN', active: true },
      tFdUdrvmm4zBSpQx: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/02-publish-content.json')), id: 'tFdUdrvmm4zBSpQx', active: true },
      ECgWasiSsSkkhV4Z: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/03-scheduled-runner.json')), id: 'ECgWasiSsSkkhV4Z', active: false },
      IgVt3iG684ChAPqG: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/04-content-management.json')), id: 'IgVt3iG684ChAPqG', active: true },
      kAu6IU5LZ6tRUoJt: { ...bindRemoteCreds(loadWorkflowJson('n8n/workflows/05-recovery-reconciliation.json')), id: 'kAu6IU5LZ6tRUoJt', active: true },
    };

    let w05Calls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/rpc/instaops_verify_health_and_rpc')) {
        return jsonRes([{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, detail: 'ok' }]);
      }
      if (url.includes('/rest/v1/instaops_accounts')) return jsonRes([{ ig_user_id: '17841453414532595', enabled: true }]);
      if (url.includes('/rest/v1/instaops_posts')) return jsonRes([]);
      if (url.includes('/rpc/instaops_get_runtime_settings')) {
        return jsonRes([{ live_publish_enabled: true, live_delete_enabled: false, scheduling_enabled: false }]);
      }
      if (url.endsWith('/api/health')) return jsonRes({ ok: true });
      if (url.endsWith('/api/n8n/resolve')) return jsonRes({ ok: false, error: 'URL missing' }, 400);
      if (url.endsWith('/api/v1/workflows?limit=100')) return jsonRes({ data: Object.values(cleanWfs) });
      for (const [id, wf] of Object.entries(cleanWfs)) {
        if (url.endsWith(`/workflows/${id}`)) return jsonRes(wf);
      }
      if (url.includes('/webhook/instaops-recovery-v1')) {
        w05Calls++;
        return jsonRes({
          ok: true,
          execution_id: `exec_${w05Calls}`,
          services: {
            supabase: { ok: true, detail: 'ok' },
            sheets: { ok: true, detail: 'ok' },
            cloudinary: { ok: true, detail: 'Free' },
            instagram: { ok: true, detail: '@vikas.sphere' },
            n8nEnv: { ok: true, settingsAvailable: true, livePublishEnabled: true, liveDeleteEnabled: false, schedulingEnabled: false },
          },
        });
      }
      return jsonRes({}, 404);
    }) as typeof fetch;

    try {
      // Coalesced parallel calls hit W05 only once
      const [r1, r2] = await Promise.all([getReadinessDiagnostics(), getReadinessDiagnostics()]);
      assert.equal(w05Calls, 1);
      assert.equal(r1.fromCache, false);
      assert.equal(r2.fromCache, false);
      assert.equal(r1.readiness.readyForExtraction, true);
      // Still fail-closed for publish because .env.local LIVE_PUBLISH_ENABLED=false even though DB=true
      assert.equal(r1.readiness.livePublishGateEnabled, false);
      assert.equal(r1.readiness.readyForPublishing, false);

      // Subsequent call serves cached result
      const r3 = await getReadinessDiagnostics();
      assert.equal(w05Calls, 1);
      assert.equal(r3.fromCache, true);

      // ?refresh=1 forces fresh probe
      const r4 = await getReadinessDiagnostics(fetch, { forceRefresh: true });
      assert.equal(w05Calls, 2);
      assert.equal(r4.fromCache, false);
    } finally {
      globalThis.fetch = origFetch;
      resetDiagnosticsCacheForTest();
    }
  });

  it('rejects expired lease renewal in LocalLockStore and enforces fail-closed runtime settings updates', async () => {
    const store = new LocalLockStore(null);
    await store.acquireLock({
      lock_key: 'post:test-1',
      post_uuid: '11111111-2222-4333-8444-555555555555',
      post_id: 'IG-L1',
      operation: 'EXTRACT',
      owner_id: 'worker_a',
      request_id: 'req_1',
      leaseSeconds: 60,
    });
    const okRenew = await store.renewLock('post:test-1', 'worker_a', 120);
    assert.equal(okRenew.renewed, true);

    // Manually backdate expiration via internal map inspection to verify expiry enforcement
    const map = (store as unknown as { locks: Map<string, { expires_at: string }> }).locks;
    const entry = map.get('post:test-1')!;
    entry.expires_at = '2020-01-01T00:00:00.000Z';
    const expiredRenew = await store.renewLock('post:test-1', 'worker_a', 120);
    assert.equal(expiredRenew.renewed, false);

    // Unconfigured Supabase rejects updateRuntimeSettings with 409
    baseLiveEnv({ SUPABASE_SERVICE_ROLE_KEY: '' });
    await assert.rejects(
      () => updateRuntimeSettings({ schedulingEnabled: true }),
      (err: Error & { httpStatus?: number }) => err.httpStatus === 409,
    );

    // Env gate=false blocks enabling livePublishEnabled via API even when Supabase is configured
    baseLiveEnv({ LIVE_PUBLISH_ENABLED: 'false' });
    await assert.rejects(
      () => updateRuntimeSettings({ livePublishEnabled: true }),
      (err: Error & { httpStatus?: number }) => err.httpStatus === 409,
    );

    // When env flag allows, calls audited instaops_update_runtime_settings RPC
    baseLiveEnv({ SCHEDULING_ENABLED: 'true' });
    let rpcCalled = false;
    const updated = await updateRuntimeSettings(
      { schedulingEnabled: true, reason: 'unit test toggle' },
      async (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/rpc/instaops_update_runtime_settings')) {
          rpcCalled = true;
          return jsonRes([{ scheduling_enabled: true, live_publish_enabled: false, live_delete_enabled: false, updated_at: '2026-11-27T12:00:00Z' }]);
        }
        return jsonRes({}, 404);
      },
    );
    assert.equal(rpcCalled, true);
    assert.equal(updated.schedulingEnabled, true);
  });
});
