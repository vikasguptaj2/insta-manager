import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GET as healthRoute } from '../../app/api/health/route';
import { GET as connectionsRoute } from '../../app/api/connections/route';
import { POST as reconcileRoute } from '../../app/api/posts/[id]/reconcile/route';
import { validateConfig } from '../../lib/config/env';
import { verifyDownloaderAuth } from '../../lib/downloader/client';
import { LocalLockStore, resetLockStoreForTest } from '../../lib/jobs/lock-store';
import { getReadinessDiagnostics } from '../../lib/service';
import { clearRateLimitBucketsForTest } from '../../lib/security/http-guard';
import { resetDemoStateForTest } from '../../lib/demo-store';

const TEST_SB_KEY = ['sb', 'service', 'key', 'e2e', '001'].join('_');
const TEST_WH_SECRET = ['whsec', 'e2e', 'test', '001'].join('_');
const TEST_DL_KEY = ['dl', 'key', 'e2e', '001'].join('_');

describe('E2E Readiness Matrix, Diagnostics Integrity & Reconcile Gate', () => {
  beforeEach(() => {
    clearRateLimitBucketsForTest();
    resetDemoStateForTest();
    resetLockStoreForTest(new LocalLockStore(null));
    process.env.DEMO_MODE = 'false';
    process.env.PUBLIC_ACCESS_ENABLED = 'false';
    process.env.ATOMIC_LOCK_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = 'https://cdgwdlhesgcxmswsamrj.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SB_KEY;
    process.env.DATABASE_URL = '';
    process.env.LIVE_PUBLISH_ENABLED = 'true';
    process.env.LIVE_DELETE_ENABLED = 'true';
    process.env.N8N_BASE_URL = 'https://137.23.61.127.sslip.io';
    process.env.N8N_API_KEY = 'test-n8n-api-key';
    process.env.N8N_WEBHOOK_SECRET = TEST_WH_SECRET;
    process.env.N8N_EXTRACT_WORKFLOW_ID = 'wf_extract_v2';
    process.env.N8N_PUBLISH_WORKFLOW_ID = 'wf_publish_v2';
    process.env.N8N_CONTENT_WORKFLOW_ID = 'wf_content_v2';
    process.env.N8N_RECOVERY_WORKFLOW_ID = 'wf_recovery_v2';
    process.env.DOWNLOADER_API_KEY = TEST_DL_KEY;
  });

  it('keeps DATABASE_URL strictly optional when Supabase REST + service_role key are configured', () => {
    const report = validateConfig();
    assert.equal(report.valid, true);
    assert.equal(report.summary.hasDatabaseUrl, false);
    assert.equal(report.summary.hasSupabaseServiceRole, true);
  });

  it('never falsely claims RLS/atomic-RPC verification from table-read alone when instaops_verify_health_and_rpc fails', async () => {
    const diag = await getReadinessDiagnostics(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('instaops_verify_health_and_rpc')) {
        return new Response(
          JSON.stringify([{ schema_ok: true, rls_ok: false, anon_revoked_ok: true, atomic_rpc_ok: false, detail: 'RLS missing on instaops_posts' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/api/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes('/api/n8n/resolve')) return new Response(JSON.stringify({ ok: false }), { status: 400 });
      if (url.includes('/api/v1/workflows/')) return new Response(JSON.stringify({ id: 'wf', name: 'wf', active: true }), { status: 200 });
      if (url.includes('/webhook/instaops-recovery-v1')) {
        return new Response(
          JSON.stringify({
            services: {
              cloudinary: { ok: true },
              instagram: { ok: true },
              sheets: { ok: true },
              n8nEnv: { ok: true, envBlocked: false, livePublishEnabled: true, liveDeleteEnabled: true },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    assert.equal(diag.readiness.databaseSchemaVerified, true);
    assert.equal(diag.readiness.rlsVerified, false);
    assert.equal(diag.readiness.atomicRpcTested, false);
    assert.equal(diag.readiness.readyForPublishing, false);
    assert.equal(diag.readiness.readyForDeletion, false);
  });

  it('detects invalid DOWNLOADER_API_KEY via resolve auth probe even when /api/health returns 200', async () => {
    const dlBad = await verifyDownloaderAuth(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes('/api/n8n/resolve')) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      return new Response('{}', { status: 404 });
    });
    assert.equal(dlBad.ok, true);
    assert.equal(dlBad.authVerified, false);

    const dlGood = await verifyDownloaderAuth(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes('/api/n8n/resolve')) return new Response(JSON.stringify({ ok: false, error: 'URL missing' }), { status: 400 });
      return new Response('{}', { status: 404 });
    });
    assert.equal(dlGood.ok, true);
    assert.equal(dlGood.authVerified, true);
  });

  it('/api/health, /api/connections, and /api/posts/[id]/reconcile return ReadinessMatrix cleanly and validate MARK_PUBLISHED input', async () => {
    process.env.DEMO_MODE = 'true';
    const healthRes = await healthRoute(new Request('http://127.0.0.1:3000/api/health', { headers: { host: '127.0.0.1:3000' } }));
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.readiness.readyForPublishing, true);
    assert.equal(healthJson.readiness.n8nEnvAccessOk, true);

    const connRes = await connectionsRoute(new Request('http://127.0.0.1:3000/api/connections', { headers: { host: '127.0.0.1:3000' } }));
    assert.equal(connRes.status, 200);
    const connJson = await connRes.json();
    assert.equal(connJson.readiness.databaseSchemaVerified, true);

    // Rejects MARK_PUBLISHED without verified published_id
    const recRes = await reconcileRoute(
      new Request('http://127.0.0.1:3000/api/posts/DEMO-PUB-01/reconcile', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ inspected: true, resolution: 'MARK_PUBLISHED' }),
      }),
      { params: Promise.resolve({ id: 'DEMO-PUB-01' }) },
    );
    assert.equal(recRes.status, 422);
  });
});
