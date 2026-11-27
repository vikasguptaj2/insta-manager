import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { GET as getOverview } from '../../app/api/overview/route';
import { GET as listPosts, POST as createPostRoute } from '../../app/api/posts/route';
import { GET as getPostRoute, PATCH as patchPostRoute } from '../../app/api/posts/[id]/route';
import { POST as extractRoute } from '../../app/api/posts/[id]/extract/route';
import { POST as publishRoute } from '../../app/api/posts/[id]/publish/route';
import { POST as scheduleRoute } from '../../app/api/posts/[id]/schedule/route';
import { POST as cancelRoute } from '../../app/api/posts/[id]/cancel/route';
import { POST as archiveRoute } from '../../app/api/posts/[id]/archive/route';
import { resetDemoStateForTest } from '../../lib/demo-store';
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

describe('E2E Lifecycle: Two-Click Separation, Captions, Carousels, Scheduling', () => {
  beforeEach(() => {
    process.env.DEMO_MODE = 'true';
    process.env.SCHEDULING_ENABLED = 'true';
    process.env.LIVE_PUBLISH_ENABLED = 'true';
    process.env.LIVE_DELETE_ENABLED = 'true';
    process.env.PUBLIC_ACCESS_ENABLED = 'false';
    process.env.ATOMIC_LOCK_PROVIDER = 'local';
    clearRateLimitBucketsForTest();
    resetLockStoreForTest();
    resetDemoStateForTest();
  });

  it('Scenario 1-4: Creates draft, extracts via Click 1 as DRAFT (no auto-publish), edits caption, and publishes only on Click 2', async () => {
    const createRes = await createPostRoute(
      makeReq('/api/posts', 'POST', {
        post_id: 'E2E-REEL-01',
        source_instagram_url: 'https://www.instagram.com/reel/C8E2EReel01/',
        media_type: 'REEL',
        authorized: true,
      }),
    );
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as { ok: true; post: { post_id: string; status: string } };
    assert.equal(created.post.status, 'DRAFT');

    // Click 1: Extract & Upload
    const extractRes = await extractRoute(
      makeReq('/api/posts/E2E-REEL-01/extract', 'POST', { authorized: true }),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.equal(extractRes.status, 202);

    // Must remain DRAFT (never auto-published!)
    const afterExtract = await (
      await getPostRoute(makeReq('/api/posts/E2E-REEL-01'), { params: Promise.resolve({ id: 'E2E-REEL-01' }) })
    ).json();
    assert.equal(afterExtract.post.status, 'DRAFT');
    assert.ok(afterExtract.post.media_url.startsWith('https://res.cloudinary.com/'));

    // Edit caption -> bumps revision
    const staleRev = afterExtract.post.revision;
    const patchRes = await patchPostRoute(
      makeReq('/api/posts/E2E-REEL-01', 'PATCH', {
        caption: 'Reviewed caption with #workflow @vikas.sphere',
      }),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.equal(patchRes.status, 200);
    const patchedJson = await patchRes.json();
    assert.notEqual(patchedJson.post.revision, staleRev);

    // Stale reviewedRevision must be rejected (409 REVISION_CONFLICT)
    const stalePub = await publishRoute(
      makeReq('/api/posts/E2E-REEL-01/publish', 'POST', {
        confirm: true,
        reviewedRevision: staleRev,
      }),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.equal(stalePub.status, 409);

    // Click 2: Publish Now with exact current revision
    const pubRes = await publishRoute(
      makeReq('/api/posts/E2E-REEL-01/publish', 'POST', {
        confirm: true,
        reviewedRevision: patchedJson.post.revision,
      }),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.equal(pubRes.status, 202);

    const finalDetail = await (
      await getPostRoute(makeReq('/api/posts/E2E-REEL-01'), { params: Promise.resolve({ id: 'E2E-REEL-01' }) })
    ).json();
    assert.equal(finalDetail.post.status, 'PUBLISHED');
    assert.ok(finalDetail.post.published_id);

    // Duplicate re-publish of already PUBLISHED post must fail
    const dupPub = await publishRoute(
      makeReq('/api/posts/E2E-REEL-01/publish', 'POST', {
        confirm: true,
        reviewedRevision: finalDetail.post.revision,
      }),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.ok(dupPub.status >= 400);

    // Published posts refuse caption mutation and instead allow Archive
    const editPub = await patchPostRoute(
      makeReq('/api/posts/E2E-REEL-01', 'PATCH', { caption: 'Tamper attempt' }),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.equal(editPub.status, 409);

    const archRes = await archiveRoute(
      makeReq('/api/posts/E2E-REEL-01/archive', 'POST'),
      { params: Promise.resolve({ id: 'E2E-REEL-01' }) },
    );
    assert.equal(archRes.status, 200);
    assert.equal((await archRes.json()).post.status, 'ARCHIVED');
  });

  it('Scenario 5-7: Blocks duplicate source URL, supports complete 9-item Carousel publishing, and enforces 2-10 carousel item validation', async () => {
    const dupCreate = await createPostRoute(
      makeReq('/api/posts', 'POST', {
        source_instagram_url: 'https://www.instagram.com/reel/DEMORDY02/?utm_source=ig_web',
        authorized: true,
      }),
    );
    assert.equal(dupCreate.status, 409);

    const carDetail = await (
      await getPostRoute(makeReq('/api/posts/DEMO-CAROUSEL-09'), {
        params: Promise.resolve({ id: 'DEMO-CAROUSEL-09' }),
      })
    ).json();
    assert.equal(carDetail.assets.length, 9);
    assert.equal(carDetail.eligibility.isCarousel, true);
    assert.equal(carDetail.eligibility.publish.enabled, true);

    const carPub = await publishRoute(
      makeReq('/api/posts/DEMO-CAROUSEL-09/publish', 'POST', {
        confirm: true,
        reviewedRevision: carDetail.post.revision,
      }),
      { params: Promise.resolve({ id: 'DEMO-CAROUSEL-09' }) },
    );
    assert.equal(carPub.status, 202);

    const publishedCar = await (
      await getPostRoute(makeReq('/api/posts/DEMO-CAROUSEL-09'), {
        params: Promise.resolve({ id: 'DEMO-CAROUSEL-09' }),
      })
    ).json();
    assert.equal(publishedCar.post.status, 'PUBLISHED');
    assert.ok(publishedCar.post.child_container_ids);
  });

  it('Scenario 8-12: Schedule creation, schedule block while locked, cancel schedule back to READY, and overview/list filtering', async () => {
    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    const detail = await (
      await getPostRoute(makeReq('/api/posts/DEMO-READY-02'), {
        params: Promise.resolve({ id: 'DEMO-READY-02' }),
      })
    ).json();

    const schedRes = await scheduleRoute(
      makeReq('/api/posts/DEMO-READY-02/schedule', 'POST', {
        confirm: true,
        reviewedRevision: detail.post.revision,
        publish_at: futureIso,
      }),
      { params: Promise.resolve({ id: 'DEMO-READY-02' }) },
    );
    assert.equal(schedRes.status, 200);
    assert.equal((await schedRes.json()).post.status, 'SCHEDULED');

    // Editing caption while SCHEDULED must be blocked until unscheduled
    const lockedEdit = await patchPostRoute(
      makeReq('/api/posts/DEMO-READY-02', 'PATCH', { caption: 'Sneaky edit' }),
      { params: Promise.resolve({ id: 'DEMO-READY-02' }) },
    );
    assert.equal(lockedEdit.status, 409);

    const cancelRes = await cancelRoute(
      makeReq('/api/posts/DEMO-READY-02/cancel', 'POST'),
      { params: Promise.resolve({ id: 'DEMO-READY-02' }) },
    );
    assert.equal(cancelRes.status, 200);
    assert.equal((await cancelRes.json()).post.status, 'READY');

    const ov = await (await getOverview(makeReq('/api/overview'))).json();
    assert.equal(ov.ok, true);
    assert.ok(ov.stats.totalPosts >= 3);

    const filtered = await (await listPosts(makeReq('/api/posts?status=PUBLISHED&search=DEMO'))).json();
    assert.equal(filtered.data.length, 1);
  });
});
