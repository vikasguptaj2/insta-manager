import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { DELETE as deletePostRoute } from '../../app/api/posts/[id]/route';
import { DELETE as deletePostMediaRoute } from '../../app/api/posts/[id]/media/route';
import { DELETE as deleteSingleAssetRoute } from '../../app/api/media/[id]/route';
import { POST as retryRoute } from '../../app/api/posts/[id]/retry/route';
import { POST as reconcileRoute } from '../../app/api/posts/[id]/reconcile/route';
import { GET as listMediaRoute } from '../../app/api/media/route';
import { GET as listExecsRoute } from '../../app/api/executions/route';
import { GET as execDetailRoute } from '../../app/api/executions/[id]/route';
import { GET as connectionsRoute } from '../../app/api/connections/route';
import { GET as storageRoute } from '../../app/api/storage/route';
import { getDemoState, resetDemoStateForTest } from '../../lib/demo-store';
import { normalizeContentRecord, normalizeMediaAssetRecord } from '../../lib/domain/schema';
import { resetLockStoreForTest } from '../../lib/jobs/lock-store';
import { clearRateLimitBucketsForTest } from '../../lib/security/http-guard';

function makeReq(path: string, method = 'GET', body?: unknown): Request {
  const headers: Record<string, string> = {
    host: '127.0.0.1:3000',
    origin: 'http://127.0.0.1:3000',
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('E2E Deletion, Unmanaged Asset Protection, Retry & Reconciliation', () => {
  beforeEach(() => {
    process.env.DEMO_MODE = 'true';
    process.env.LIVE_PUBLISH_ENABLED = 'true';
    process.env.LIVE_DELETE_ENABLED = 'true';
    process.env.PUBLIC_ACCESS_ENABLED = 'false';
    clearRateLimitBucketsForTest();
    resetLockStoreForTest();
    resetDemoStateForTest();
  });

  it('Scenario 13-16: Single Carousel asset deletion, Option A Delete Media Only, Option B Delete Post, Published & UNMANAGED protection', async () => {
    // Single asset deletion inside 9-slide carousel
    const delOne = await deleteSingleAssetRoute(
      makeReq('/api/media/ast_DEMO-CAROUSEL-09_8', 'DELETE', { confirm: true, reason: 'Remove extra slide' }),
      { params: Promise.resolve({ id: 'ast_DEMO-CAROUSEL-09_8' }) },
    );
    assert.equal(delOne.status, 200);
    assert.equal((await delOne.json()).storage_status, 'DELETED');

    // UNMANAGED asset must be rejected cleanly
    const demo = getDemoState();
    demo.assets.push(
      normalizeMediaAssetRecord({
        internal_asset_id: 'ast_UNMANAGED_1',
        post_id: 'DEMO-READY-02',
        cloudinary_public_id: '',
        storage_status: 'UNMANAGED',
      }),
    );
    const blockedUnmanaged = await deleteSingleAssetRoute(
      makeReq('/api/media/ast_UNMANAGED_1', 'DELETE', { confirm: true }),
      { params: Promise.resolve({ id: 'ast_UNMANAGED_1' }) },
    );
    assert.equal(blockedUnmanaged.status, 409);

    // Published post Option B deletion blocked
    const blockedPubDel = await deletePostRoute(
      makeReq('/api/posts/DEMO-PUB-01', 'DELETE', { confirm: true }),
      { params: Promise.resolve({ id: 'DEMO-PUB-01' }) },
    );
    assert.equal(blockedPubDel.status, 409);

    // Option A: Delete media only on Carousel -> MEDIA_DELETED
    const delMediaOnly = await deletePostMediaRoute(
      makeReq('/api/posts/DEMO-CAROUSEL-09/media', 'DELETE', { confirm: true, reason: 'Clean storage' }),
      { params: Promise.resolve({ id: 'DEMO-CAROUSEL-09' }) },
    );
    assert.equal(delMediaOnly.status, 200);
    assert.equal((await delMediaOnly.json()).status, 'MEDIA_DELETED');

    // Option B: Delete Post & Media -> DELETED
    const delPost = await deletePostRoute(
      makeReq('/api/posts/DEMO-CAROUSEL-09', 'DELETE', { confirm: true, reason: 'Remove draft completely' }),
      { params: Promise.resolve({ id: 'DEMO-CAROUSEL-09' }) },
    );
    assert.equal(delPost.status, 200);
    assert.equal((await delPost.json()).status, 'DELETED');
  });

  it('Scenario 17-23: Recovery VERIFY_MANUALLY reconciliation, Safe Retry inspection gate, executions & health APIs', async () => {
    const demo = getDemoState();
    demo.posts.push(
      normalizeContentRecord({
        post_id: 'REC-UNKNOWN-1',
        status: 'VERIFY_MANUALLY',
        container_id: '17888001122',
        error_code: 'PUBLISH_OUTCOME_UNKNOWN',
      }),
      normalizeContentRecord({
        post_id: 'REC-FAILED-1',
        status: 'FAILED',
        error_code: 'DOWNLOADER_FAILED',
      }),
    );

    // Blind retry on VERIFY_MANUALLY blocked
    const blindRetry = await retryRoute(
      makeReq('/api/posts/REC-UNKNOWN-1/retry', 'POST', { inspected: true }),
      { params: Promise.resolve({ id: 'REC-UNKNOWN-1' }) },
    );
    assert.equal(blindRetry.status, 409);

    // Reconcile requires inspected: true and published_id for MARK_PUBLISHED
    const noInspect = await reconcileRoute(
      makeReq('/api/posts/REC-UNKNOWN-1/reconcile', 'POST', {
        inspected: false,
        resolution: 'MARK_PUBLISHED',
        published_id: '18011223344',
      }),
      { params: Promise.resolve({ id: 'REC-UNKNOWN-1' }) },
    );
    assert.equal(noInspect.status, 403);

    const recOk = await reconcileRoute(
      makeReq('/api/posts/REC-UNKNOWN-1/reconcile', 'POST', {
        inspected: true,
        resolution: 'MARK_PUBLISHED',
        published_id: '18011223344',
        published_url: 'https://www.instagram.com/reel/C8Verified/',
      }),
      { params: Promise.resolve({ id: 'REC-UNKNOWN-1' }) },
    );
    assert.equal(recOk.status, 200);
    assert.equal((await recOk.json()).status, 'PUBLISHED');

    // Retry FAILED post with inspected: true -> DRAFT
    const retryOk = await retryRoute(
      makeReq('/api/posts/REC-FAILED-1/retry', 'POST', { inspected: true }),
      { params: Promise.resolve({ id: 'REC-FAILED-1' }) },
    );
    assert.equal(retryOk.status, 200);
    assert.equal((await retryOk.json()).status, 'DRAFT');

    // Media, Storage, Connections & Executions APIs respond cleanly
    const [mRes, sRes, cRes, eRes, edRes] = await Promise.all([
      listMediaRoute(makeReq('/api/media')),
      storageRoute(makeReq('/api/storage')),
      connectionsRoute(makeReq('/api/connections')),
      listExecsRoute(makeReq('/api/executions')),
      execDetailRoute(makeReq('/api/executions/demo-exec-101'), {
        params: Promise.resolve({ id: 'demo-exec-101' }),
      }),
    ]);

    assert.equal(mRes.status, 200);
    assert.equal(sRes.status, 200);
    assert.equal(cRes.status, 200);
    assert.equal(eRes.status, 200);
    assert.equal(edRes.status, 200);
  });
});
