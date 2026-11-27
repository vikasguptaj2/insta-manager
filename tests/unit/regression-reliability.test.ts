import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { LocalLockStore, resetLockStoreForTest } from '../../lib/jobs/lock-store';
import { resetDemoStateForTest } from '../../lib/demo-store';
import {
  deletePostAndMedia,
  flushSyncQueueToSheets,
  getSyncStatusAndFlush,
  retryOrReconcilePost,
  schedulePost,
  triggerExtractPost,
  triggerPublishPost,
} from '../../lib/service';

const POST_UUID = '22222222-2222-4222-8222-222222222222';
const POST_ID = 'IG-REL-200';
const WH_SECRET = ['whsec', 'regression', 'test', '999'].join('_');
const SB_KEY = ['sb', 'service', 'key', 'test', '999'].join('_');

function configureMockSupabaseLiveEnv(): LocalLockStore {
  process.env.DEMO_MODE = 'false';
  process.env.ATOMIC_LOCK_PROVIDER = 'supabase';
  process.env.SUPABASE_URL = 'https://cdgwdlhesgcxmswsamrj.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SB_KEY;
  process.env.DATABASE_URL = '';
  process.env.CLOUDINARY_CLOUD_NAME = 'djkkknb9k';
  process.env.LIVE_PUBLISH_ENABLED = 'true';
  process.env.LIVE_DELETE_ENABLED = 'true';
  process.env.SCHEDULING_ENABLED = 'true';
  process.env.SHEETS_SYNC_ENABLED = 'true';
  process.env.N8N_BASE_URL = 'https://137.23.61.127.sslip.io';
  process.env.N8N_API_KEY = 'test-n8n-api-key';
  process.env.N8N_WEBHOOK_SECRET = WH_SECRET;
  process.env.N8N_EXTRACT_WORKFLOW_ID = 'wf_extract_v2';
  process.env.N8N_PUBLISH_WORKFLOW_ID = 'wf_publish_v2';
  process.env.N8N_CONTENT_WORKFLOW_ID = 'wf_content_v2';
  process.env.N8N_RECOVERY_WORKFLOW_ID = 'wf_recovery_v2';

  const localStore = new LocalLockStore(null);
  resetLockStoreForTest(localStore);
  return localStore;
}

describe('InstaOps v2.0 Production Reliability Regressions', () => {
  beforeEach(() => {
    resetDemoStateForTest();
  });

  it('uses canonical post:<uuid> lock key, persists QUEUED job BEFORE dispatch, and preserves lock + VERIFY_MANUALLY on webhook timeout', async () => {
    const store = configureMockSupabaseLiveEnv();
    let approvedCalled = false;
    let jobPersistedBeforeWebhook = false;
    const statusUpdates: Array<Record<string, unknown>> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes('/api/n8n/resolve')) return new Response(JSON.stringify({ ok: false }), { status: 400 });
      if (url.includes('/api/v1/workflows/')) return new Response(JSON.stringify({ id: 'wf_publish_v2', name: 'W02', active: true }), { status: 200 });
      if (url.includes('/api/v1/executions')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.includes('/rest/v1/rpc/instaops_verify_health_and_rpc')) {
        return new Response(JSON.stringify([{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, active_accounts_count: 1 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/v1/rpc/instaops_approve_post_revision')) {
        approvedCalled = true;
        return new Response(
          JSON.stringify({
            id: POST_UUID,
            post_id: POST_ID,
            source_instagram_url: 'https://www.instagram.com/reel/C8RelTest/',
            media_type: 'IMAGE',
            media_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/instaops/IG-REL-200/item_0.jpg',
            caption: 'Ready caption',
            status: 'READY',
            revision: 2,
            approved_revision: 2,
            account_key: 'A',
            ig_user_id: '17841453414532595',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_posts') && (!init?.method || init.method === 'GET')) {
        return new Response(
          JSON.stringify([
            {
              id: POST_UUID,
              post_id: POST_ID,
              source_instagram_url: 'https://www.instagram.com/reel/C8RelTest/',
              media_type: 'IMAGE',
              media_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/instaops/IG-REL-200/item_0.jpg',
              caption: 'Ready caption',
              status: 'READY',
              revision: 2,
              approved_revision: 0,
              account_key: 'A',
              ig_user_id: '17841453414532595',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_posts') && init?.method === 'PATCH') {
        statusUpdates.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ id: POST_UUID, post_id: POST_ID, status: 'VERIFY_MANUALLY', revision: 2 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_media_assets')) {
        return new Response(
          JSON.stringify([
            {
              id: 'ast-uuid-1',
              post_uuid: POST_UUID,
              internal_asset_id: 'ast_IG-REL-200_0',
              post_id: POST_ID,
              media_index: 0,
              media_type: 'IMAGE',
              resource_type: 'image',
              delivery_type: 'upload',
              cloudinary_public_id: 'instaops/IG-REL-200/item_0',
              secure_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/instaops/IG-REL-200/item_0.jpg',
              storage_status: 'ACTIVE',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_accounts')) {
        return new Response(JSON.stringify([{ id: 'acc-1', enabled: true, ig_user_id: '17841453414532595', account_key: 'A' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/v1/instaops_jobs')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/webhook/instaops-publish-v1')) {
        // Verify job was persisted to lockStore BEFORE webhook dispatch!
        const jobs = await store.listJobs(10);
        jobPersistedBeforeWebhook = jobs.some((j) => j.operation === 'PUBLISH' && j.status === 'QUEUED' && j.lock_key === `post:${POST_UUID}`);
        throw new Error('AbortError: webhook timeout');
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await assert.rejects(
      () => triggerPublishPost(POST_ID, { reviewedRevision: '2', confirm: true }, mockFetch),
      /Publish webhook outcome uncertain/i,
    );

    assert.equal(approvedCalled, true);
    assert.equal(jobPersistedBeforeWebhook, true);

    const activeLocks = await store.listActiveLocks();
    assert.equal(activeLocks.length, 1);
    assert.equal(activeLocks[0]?.lock_key, `post:${POST_UUID}`);
    assert.ok(statusUpdates.some((u) => u.status === 'VERIFY_MANUALLY' && u.error_code === 'PUBLISH_OUTCOME_UNKNOWN'));

    // Concurrent extraction OR schedule on same post_<uuid> lock key MUST reject cleanly!
    await assert.rejects(
      () => triggerExtractPost(POST_ID, { authorized: true }, mockFetch),
      /Lock conflict|active lock|LOCKED/i,
    );
    await assert.rejects(
      () => schedulePost(POST_ID, { reviewedRevision: '2', publish_at: new Date(Date.now() + 3_600_000).toISOString(), confirm: true }, mockFetch),
      /locked|VERIFY_MANUALLY|cannot|POST_LOCKED/i,
    );
  });

  it('deletePostAndMedia checkpoints partial Cloudinary deletions, refuses parent soft-delete on any failure, and marks DELETE_OUTCOME_UNKNOWN on post-Cloudinary DB error', async () => {
    const store = configureMockSupabaseLiveEnv();
    const finalizeCalls: Array<Record<string, unknown>> = [];
    let softDeleteCalled = false;
    let simulateDbFailure = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/rest/v1/rpc/instaops_verify_health_and_rpc')) {
        return new Response(JSON.stringify([{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/rest/v1/instaops_posts')) {
        return new Response(
          JSON.stringify({ id: POST_UUID, post_id: POST_ID, status: 'DRAFT', revision: 1, published_id: '', source_instagram_url: 'https://www.instagram.com/p/Del1/' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_media_assets')) {
        return new Response(
          JSON.stringify([
            {
              id: 'a1',
              post_uuid: POST_UUID,
              internal_asset_id: 'ast_1',
              post_id: POST_ID,
              media_index: 0,
              cloudinary_public_id: `instaops-v2/${POST_ID}/item_0_p0`,
              secure_url: `https://res.cloudinary.com/djkkknb9k/image/upload/v1/instaops-v2/${POST_ID}/item_0_p0.jpg`,
              resource_type: 'image',
              delivery_type: 'upload',
              storage_status: 'ACTIVE',
            },
            {
              id: 'a2',
              post_uuid: POST_UUID,
              internal_asset_id: 'ast_2',
              post_id: POST_ID,
              media_index: 1,
              cloudinary_public_id: `instaops-v2/${POST_ID}/item_1_p1`,
              secure_url: `https://res.cloudinary.com/djkkknb9k/video/upload/v1/instaops-v2/${POST_ID}/item_1_p1.mp4`,
              resource_type: 'video',
              delivery_type: 'upload',
              storage_status: 'ACTIVE',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/webhook/instaops-content-v1')) {
        return new Response(
          JSON.stringify({
            ok: true,
            partial_failure: true,
            outcomes: [
              { internal_asset_id: 'ast_1', public_id: `instaops-v2/${POST_ID}/item_0_p0`, result: 'ok' },
              { internal_asset_id: 'ast_2', public_id: `instaops-v2/${POST_ID}/item_1_p1`, result: 'error', error: 'Cloudinary 500' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/rpc/instaops_soft_delete_post')) {
        softDeleteCalled = true;
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (url.includes('/rest/v1/rpc/instaops_finalize_deletion')) {
        if (simulateDbFailure) {
          return new Response(JSON.stringify({ message: 'DB connection lost during checkpoint' }), { status: 500, headers: { 'content-type': 'application/json' } });
        }
        finalizeCalls.push(JSON.parse(String(init?.body || '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify([{ post_status: 'FAILED', confirmed_count: 1, failed_count: 1 }]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await assert.rejects(
      () => deletePostAndMedia(POST_ID, { confirm: true, reason: 'cleanup' }, mockFetch),
      /Parent post NOT deleted/i,
    );
    assert.equal(softDeleteCalled, false);
    assert.equal(finalizeCalls[0]?.p_operation, 'DELETE_MEDIA');
    assert.deepEqual(finalizeCalls[0]?.p_confirmed_asset_ids, ['ast_1']);
    assert.equal((finalizeCalls[0]?.p_failed_assets as unknown[]).length, 1);

    // Post-Cloudinary DB failure marks job OUTCOME_UNKNOWN with error DELETE_OUTCOME_UNKNOWN
    simulateDbFailure = true;
    await assert.rejects(
      () => deletePostAndMedia(POST_ID, { confirm: true, reason: 'cleanup' }, mockFetch),
      /Deletion checkpoint RPC failed/i,
    );
    const jobs = await store.listJobs(10);
    assert.ok(jobs.some((j) => j.status === 'OUTCOME_UNKNOWN' && j.error_code === 'DELETE_OUTCOME_UNKNOWN'));
  });

  it('recovers stale sync queue items, suppresses older-revision outbox rows, and rejects unverified MARK_PUBLISHED in live mode', async () => {
    configureMockSupabaseLiveEnv();
    let staleRecoveredCalled = false;
    let webhookSyncCalled = 0;

    const syncMockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/rest/v1/rpc/instaops_recover_stale_sync_jobs')) {
        staleRecoveredCalled = true;
        return new Response(JSON.stringify(2), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/rest/v1/rpc/instaops_claim_sync_batch')) {
        return new Response(
          JSON.stringify([
            {
              id: 'sync_stale_1',
              entity_type: 'POST',
              entity_uuid: POST_UUID,
              external_id: POST_ID,
              operation: 'UPSERT',
              source_revision: 1,
              payload: { post_uuid: POST_UUID, row: { post_id: POST_ID, revision: '1' } },
              attempts: 1,
              max_attempts: 5,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_posts') && (!init?.method || init.method === 'GET')) {
        const accept = new Headers(init?.headers).get('accept') ?? '';
        const row = { id: POST_UUID, post_id: POST_ID, status: 'VERIFY_MANUALLY', revision: 4, container_id: 'c_1' };
        return new Response(JSON.stringify(accept.includes('object+json') ? row : [row]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/webhook/instaops-content-v1')) {
        webhookSyncCalled++;
        return new Response(JSON.stringify({ ok: true, synced: true }), { status: 200 });
      }
      if (url.includes('/webhook/instaops-recovery-v1')) {
        return new Response(JSON.stringify({ ok: false, verified: false, error: 'Not found on Meta Graph' }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const statusFlush = await getSyncStatusAndFlush('FLUSH', syncMockFetch);
    assert.equal(staleRecoveredCalled, true);
    // Outbox item rev 1 vs DB rev 4 must be suppressed cleanly without dispatching stale overwrite to Sheets
    assert.equal(statusFlush.flushed?.succeeded, 1);
    assert.equal(webhookSyncCalled, 0);

    // Direct flush test when W04 returns synced: false must mark FAILED instead of false SUCCEEDED
    const failFlush = await flushSyncQueueToSheets(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('instaops_claim_sync_batch')) {
        return new Response(
          JSON.stringify([{ id: 'sync_cur_2', entity_type: 'MEDIA_ASSET', entity_uuid: 'ast-uuid-2', external_id: 'ast_2', operation: 'UPSERT', source_revision: 4, payload: {}, attempts: 1, max_attempts: 5 }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/webhook/instaops-content-v1')) {
        return new Response(JSON.stringify({ ok: true, synced: false }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.equal(failFlush.failed, 1);
    assert.equal(failFlush.succeeded, 0);

    // Reconciliation must block MARK_PUBLISHED unless W05 proves it via Meta Graph API
    const ovFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/rest/v1/instaops_posts')) {
        return new Response(JSON.stringify([{ id: POST_UUID, post_id: POST_ID, status: 'VERIFY_MANUALLY', revision: 4, source_instagram_url: 'https://www.instagram.com/p/Rec/' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return syncMockFetch(input, init);
    };

    await assert.rejects(
      () => retryOrReconcilePost('RECONCILE', POST_ID, { inspected: true, resolution: 'MARK_PUBLISHED', published_id: '179999999' }, ovFetch),
      /Not found on Meta Graph|PUBLISH_OUTCOME_UNKNOWN/i,
    );
  });
});
