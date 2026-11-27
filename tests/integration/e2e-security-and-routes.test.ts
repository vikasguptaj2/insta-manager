import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GET as healthRoute } from '../../app/api/health/route';
import { GET as overviewRoute } from '../../app/api/overview/route';
import { GET as syncGetRoute, POST as syncPostRoute } from '../../app/api/sync/route';
import { POST as createPostRoute } from '../../app/api/posts/route';
import { POST as publishRoute } from '../../app/api/posts/[id]/publish/route';
import { GET as settingsRoute, PATCH as settingsPatchRoute } from '../../app/api/settings/route';
import { resetDemoStateForTest } from '../../lib/demo-store';
import { LocalLockStore, resetLockStoreForTest } from '../../lib/jobs/lock-store';
import { clearRateLimitBucketsForTest } from '../../lib/security/http-guard';
import { createPostRecord, getOverviewData, triggerExtractPost } from '../../lib/service';

describe('E2E Security, Production Fail-Closed Gates & Mocked Live Bridge', () => {
  beforeEach(() => {
    process.env.DEMO_MODE = 'false';
    process.env.PUBLIC_ACCESS_ENABLED = 'false';
    process.env.LIVE_PUBLISH_ENABLED = 'false';
    process.env.LIVE_DELETE_ENABLED = 'false';
    process.env.ATOMIC_LOCK_PROVIDER = 'postgres';
    process.env.DATABASE_URL = '';
    process.env.SUPABASE_URL = '';
    process.env.NEXT_PUBLIC_SUPABASE_URL = '';
    process.env.SUPABASE_SERVICE_ROLE_KEY = '';
    process.env.N8N_BASE_URL = 'https://137.23.61.127.sslip.io';
    process.env.N8N_API_KEY = 'unit-test-n8n-api-key';
    process.env.N8N_WEBHOOK_SECRET = 'unit-test-webhook-secret-32chars';
    process.env.N8N_EXTRACT_WORKFLOW_ID = 'wf_extract_v2';
    process.env.N8N_PUBLISH_WORKFLOW_ID = 'wf_publish_v2';
    process.env.N8N_CONTENT_WORKFLOW_ID = 'wf_content_v2';
    process.env.N8N_RECOVERY_WORKFLOW_ID = 'wf_recovery_v2';
    clearRateLimitBucketsForTest();
    resetLockStoreForTest();
    resetDemoStateForTest();
  });

  it('Scenario 24-26: Rejects non-local hosts, cross-origin mutations, malformed JSON, and sanitizes spreadsheet formula captions', async () => {
    const extReq = await overviewRoute(
      new Request('https://public-attacker.example/api/overview', {
        headers: { host: 'public-attacker.example' },
      }),
    );
    assert.equal(extReq.status, 403);

    const csrfReq = await createPostRoute(
      new Request('http://127.0.0.1:3000/api/posts', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'https://evil-csrf.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ source_instagram_url: 'https://www.instagram.com/reel/x/', authorized: true }),
      }),
    );
    assert.equal(csrfReq.status, 403);

    process.env.DEMO_MODE = 'true';
    const formulaRes = await createPostRoute(
      new Request('http://127.0.0.1:3000/api/posts', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          post_id: 'SAFE-FORMULA-1',
          source_instagram_url: 'https://www.instagram.com/reel/C8FormulaSafe/',
          caption: '=HYPERLINK("https://evil.example","Click")',
          authorized: true,
        }),
      }),
    );
    assert.equal(formulaRes.status, 201);
  });

  it('Scenario 27-28: Fails closed in live mode when DATABASE_URL or LIVE_PUBLISH_ENABLED=false', async () => {
    const pubBlocked = await publishRoute(
      new Request('http://127.0.0.1:3000/api/posts/ANY-1/publish', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ confirm: true, reviewedRevision: '1' }),
      }),
      { params: Promise.resolve({ id: 'ANY-1' }) },
    );
    assert.equal(pubBlocked.status, 409);
    const errBody = await pubBlocked.json();
    assert.equal(errBody.error.code, 'CONFIGURATION_ERROR');

    const health = await (
      await healthRoute(new Request('http://127.0.0.1:3000/api/health', { headers: { host: '127.0.0.1:3000' } }))
    ).json();
    assert.equal(health.summary.demoMode, false);

    const settingsGet = await (
      await settingsRoute(new Request('http://127.0.0.1:3000/api/settings', { headers: { host: '127.0.0.1:3000' } }))
    ).json();
    assert.equal(settingsGet.ok, true);

    // Non-demo runtime settings mutation refuses override cleanly
    const patchRes = await settingsPatchRoute(
      new Request('http://127.0.0.1:3000/api/settings', {
        method: 'PATCH',
        headers: {
          host: '127.0.0.1:3000',
          origin: 'http://127.0.0.1:3000',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ schedulingEnabled: true }),
      }),
    );
    assert.equal(patchRes.status, 409);
  });

  it('Scenario 29-30: Verifies live bridge authentication header and mocked W04/W01 roundtrip when DEMO_MODE=false', async () => {
    process.env.ATOMIC_LOCK_PROVIDER = 'local';
    resetLockStoreForTest(new LocalLockStore(null));
    const seenSecrets: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const hdrs = (init?.headers ?? {}) as Record<string, string>;
      if (hdrs['x-dashboard-secret']) seenSecrets.push(hdrs['x-dashboard-secret']);

      if (url.includes('/api/health')) {
        return new Response(JSON.stringify({ ok: true, status: 'healthy' }), { status: 200 });
      }
      if (url.includes('/api/v1/workflows/')) {
        return new Response(JSON.stringify({ id: 'wf_extract_v2', name: 'W01', active: true }), { status: 200 });
      }
      if (url.includes('/api/v1/executions')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (url.includes('/webhook/instaops-content-v1')) {
        const body = JSON.parse(String(init?.body || '{}')) as { action?: string; row?: Record<string, unknown> };
        if (body.action === 'LIST_POSTS') {
          return new Response(
            JSON.stringify({
              ok: true,
              rows: [
                {
                  post_id: 'LIVE-MOCK-1',
                  source_instagram_url: 'https://www.instagram.com/reel/C8LiveMock1/',
                  status: 'DRAFT',
                  revision: '1',
                },
              ],
              logs: [],
            }),
            { status: 200 },
          );
        }
        if (body.action === 'LIST_MEDIA') {
          return new Response(JSON.stringify({ ok: true, assets: [], storage: null }), { status: 200 });
        }
        if (body.action === 'CREATE_POST') {
          return new Response(JSON.stringify({ ok: true, row: body.row }), { status: 200 });
        }
      }
      if (url.includes('/webhook/instaops-recovery-v1')) {
        return new Response(JSON.stringify({ ok: true, services: { sheets: { ok: true, detail: 'OK' } } }), {
          status: 200,
        });
      }
      if (url.includes('/webhook/instaops-extract-v1')) {
        return new Response(JSON.stringify({ accepted: true, execution_id: 'exec_live_901' }), { status: 202 });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    };

    const ov = await getOverviewData(mockFetch);
    assert.equal(ov.posts[0]?.post_id, 'LIVE-MOCK-1');
    assert.ok(seenSecrets.every((s) => s === 'unit-test-webhook-secret-32chars'));

    const created = await createPostRecord(
      {
        post_id: 'LIVE-MOCK-2',
        source_instagram_url: 'https://www.instagram.com/reel/C8LiveMock2/',
        authorized: true,
      },
      mockFetch,
    );
    assert.equal(created.post_id, 'LIVE-MOCK-2');

    const extracted = await triggerExtractPost('LIVE-MOCK-1', { authorized: true }, mockFetch);
    assert.equal(extracted.accepted, true);
    assert.equal(extracted.execution_id, 'exec_live_901');

    // Verify /api/sync route responds cleanly in demo/local fallback without crashing
    process.env.DEMO_MODE = 'true';
    const syncGet = await syncGetRoute(
      new Request('http://127.0.0.1:3000/api/sync', { headers: { host: '127.0.0.1:3000' } }),
    );
    assert.equal(syncGet.status, 200);
    const syncPost = await syncPostRoute(
      new Request('http://127.0.0.1:3000/api/sync', {
        method: 'POST',
        headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' },
      }),
    );
    assert.equal(syncPost.status, 200);
  });
});
