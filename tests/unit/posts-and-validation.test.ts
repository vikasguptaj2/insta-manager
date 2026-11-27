import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyContentCreate,
  applyContentPatch,
  buildReviewSnapshot,
  canonicalizeInstagramUrl,
  computePostProgress,
  evaluatePostEligibility,
  extractSourceShortcode,
  parseHashtagsAndMentions,
} from '../../lib/domain/posts';
import { normalizeContentRecord, normalizeMediaAssetRecord } from '../../lib/domain/schema';
import {
  parseCreatePostInput,
  parsePublishPostInput,
  parseRetryOrReconcileInput,
  parseSchedulePostInput,
} from '../../lib/validation/requests';

describe('Posts domain rules, revisions & action eligibility', () => {
  it('canonicalizes Instagram URLs and extracts shortcodes cleanly', () => {
    assert.equal(extractSourceShortcode('https://www.instagram.com/reel/C8xYz_12Ab/?igsh=abc'), 'C8xYz_12Ab');
    assert.equal(extractSourceShortcode('https://instagram.com/p/C9AbcDE12/'), 'C9AbcDE12');
    assert.equal(
      canonicalizeInstagramUrl('https://instagram.com/reel/C8xYz_12Ab/?utm_source=ig_web_copy_link'),
      'https://www.instagram.com/reel/C8xYz_12Ab/',
    );
    assert.equal(extractSourceShortcode('https://example.com/reel/C8xYz_12Ab/'), '');
  });

  it('enforces authorization and duplicate detection on create', () => {
    const first = applyContentCreate(
      {
        post_id: 'IG-001',
        source_instagram_url: 'https://www.instagram.com/reel/C8DupCheck1/',
        authorized: true,
      },
      [],
    );
    assert.equal(first.status, 'DRAFT');
    assert.equal(first.source_id, 'C8DupCheck1');
    assert.match(first.id ?? '', /^[0-9a-f-]{36}$/i);

    assert.throws(
      () =>
        applyContentCreate(
          {
            source_instagram_url: 'https://www.instagram.com/reel/C8DupCheck1/?igsh=123',
            authorized: true,
          },
          [first],
        ),
      /already exists/i,
    );

    assert.throws(
      () =>
        applyContentCreate(
          {
            source_instagram_url: 'https://www.instagram.com/reel/C8Other123/',
            authorized: false,
          },
          [],
        ),
      /Confirm you own/i,
    );
  });

  it('bumps revision and clears approved_revision when patching captions', () => {
    const row = normalizeContentRecord({
      post_id: 'IG-002',
      source_instagram_url: 'https://www.instagram.com/reel/C8RevTest1/',
      status: 'READY',
      revision: '2',
      approved_revision: '2',
      caption: 'Old caption',
    });

    const patched = applyContentPatch(row, { caption: 'Updated #InstaOps @vikas.sphere' }, [row]);
    assert.equal(patched.revision, '3');
    assert.equal(patched.approved_revision, '');
    assert.equal(patched.status, 'DRAFT');

    const tags = parseHashtagsAndMentions(patched.caption);
    assert.deepEqual(tags.hashtags, ['#instaops']);
    assert.deepEqual(tags.mentions, ['@vikas.sphere']);
    const snap = JSON.parse(buildReviewSnapshot(patched)) as string[];
    assert.equal(snap[0], 'IG-002');
    assert.equal(snap[9], '3');
  });

  it('allows Carousel publishing when 2-10 mixed assets exist and blocks <2 asset carousels', () => {
    const carousel = normalizeContentRecord({
      id: '550e8400-e29b-41d4-a716-446655440001',
      post_id: 'IG-CAR-1',
      source_instagram_url: 'https://www.instagram.com/p/C8Carousel9/',
      media_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/slide0.jpg',
      media_type: 'CAROUSEL',
      media_count: '2',
      caption: 'Mixed carousel caption',
      status: 'READY',
    });
    const slide0 = normalizeMediaAssetRecord({
      internal_asset_id: 'ast_car_0',
      post_id: 'IG-CAR-1',
      media_index: 0,
      media_type: 'IMAGE',
      resource_type: 'image',
      cloudinary_public_id: 'instaops-v2/IG-CAR-1/item_0',
      secure_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/slide0.jpg',
      storage_status: 'ACTIVE',
    });
    const slide1 = normalizeMediaAssetRecord({
      internal_asset_id: 'ast_car_1',
      post_id: 'IG-CAR-1',
      media_index: 1,
      media_type: 'VIDEO',
      resource_type: 'video',
      cloudinary_public_id: 'instaops-v2/IG-CAR-1/item_1',
      secure_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1/slide1.mp4',
      storage_status: 'ACTIVE',
    });

    const singleOnly = evaluatePostEligibility(carousel, {
      rows: [carousel],
      assets: [slide0],
      executions: [],
      canWrite: true,
      schedulingEnabled: true,
      livePublishEnabled: true,
      liveDeleteEnabled: true,
      demoMode: true,
      cooldown: { blocked: false, until: null, unknown: false },
    });
    assert.equal(singleOnly.publish.enabled, false);
    assert.match(singleOnly.publish.reason, /2 to 10 active media assets/i);

    const mixedReady = evaluatePostEligibility(carousel, {
      rows: [carousel],
      assets: [slide0, slide1],
      executions: [],
      canWrite: true,
      schedulingEnabled: true,
      livePublishEnabled: true,
      liveDeleteEnabled: true,
      demoMode: true,
      cooldown: { blocked: false, until: null, unknown: false },
    });

    assert.equal(mixedReady.isCarousel, true);
    assert.equal(mixedReady.publish.enabled, true);
    assert.equal(mixedReady.schedule.enabled, true);
    assert.equal(mixedReady.deleteMedia.enabled, true);
    assert.equal(computePostProgress(carousel).total, 5);
  });

  it('validates boundary request parsers strictly', () => {
    assert.throws(() => parseCreatePostInput({ source_instagram_url: 'https://www.instagram.com/p/abc/', authorized: false }));
    assert.throws(() => parsePublishPostInput({ confirm: true, reviewedRevision: '' }));
    assert.throws(() => parseSchedulePostInput({ confirm: true, reviewedRevision: '1', publish_at: '' }));
    assert.throws(() => parseRetryOrReconcileInput({ inspected: true, resolution: 'INVALID_OP' }));
  });
});
