import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertDeletableAssetOwnership,
  assertPostDeletable,
  buildOwnedPublicId,
  summarizeDeletionOutcomes,
} from '../../lib/cloudinary/assets';
import { classifyDownloaderHttpFailure, parseDownloaderResolveResponse } from '../../lib/downloader/parser';
import { normalizeContentRecord, normalizeMediaAssetRecord } from '../../lib/domain/schema';

describe('Hosted downloader parser & Cloudinary ownership governance', () => {
  it('parses Reel response including hashtags, mentions, and source engagement metrics', async () => {
    const parsed = await parseDownloaderResolveResponse(
      {
        ok: true,
        status: 'ready',
        platform: 'instagram',
        kind: 'reel',
        canonicalUrl: 'https://www.instagram.com/reel/C8SampleReel/',
        sourceUsername: '@creator_demo',
        sourceId: 'C8SampleReel',
        caption: 'Behind the scenes #Studio @vikas.sphere',
        captionStatus: 'available',
        captionSource: 'structured',
        hashtags: ['#Studio'],
        mentions: ['@vikas.sphere'],
        postMetadata: {
          mediaCount: 1,
          imageCount: 0,
          videoCount: 1,
          likeCount: 1200,
          commentCount: 44,
          playCount: 18500,
        },
        media: [
          {
            type: 'video',
            url: 'https://scontent.cdninstagram.com/v/t50.2886-16/demo-reel.mp4',
            fileSizeBytes: 5400123,
          },
        ],
      },
      { skipDnsLookup: true },
    );

    assert.equal(parsed.sourceId, 'C8SampleReel');
    assert.equal(parsed.captionStatus, 'available');
    assert.equal(parsed.postMetadata.playCount, 18500);
    assert.equal(parsed.media.length, 1);
  });

  it('distinguishes empty caption vs unavailable caption and handles 9-slide Carousels', async () => {
    const emptyCap = await parseDownloaderResolveResponse(
      {
        ok: true,
        status: 'ready',
        platform: 'instagram',
        kind: 'post',
        canonicalUrl: 'https://www.instagram.com/p/C8EmptyCap1/',
        sourceId: 'C8EmptyCap1',
        caption: '',
        captionStatus: 'empty',
        media: [{ type: 'image', url: 'https://scontent.cdninstagram.com/v/photo.jpg' }],
      },
      { skipDnsLookup: true },
    );
    assert.equal(emptyCap.captionStatus, 'empty');

    const unavailableCap = await parseDownloaderResolveResponse(
      {
        ok: true,
        status: 'ready',
        platform: 'instagram',
        kind: 'carousel',
        canonicalUrl: 'https://www.instagram.com/p/C8CarNine9/',
        sourceId: 'C8CarNine9',
        caption: '',
        captionStatus: 'unavailable',
        media: Array.from({ length: 9 }, (_, i) => ({
          type: i % 3 === 0 ? ('video' as const) : ('image' as const),
          url: `https://scontent.cdninstagram.com/v/slide-${i}.${i % 3 === 0 ? 'mp4' : 'jpg'}`,
        })),
      },
      { skipDnsLookup: true },
    );
    assert.equal(unavailableCap.media.length, 9);
    assert.equal(unavailableCap.postMetadata.videoCount, 3);
    assert.equal(unavailableCap.postMetadata.imageCount, 6);
    assert.equal(unavailableCap.captionStatus, 'unavailable');
  });

  it('classifies HTTP 429 cooldown vs 401 auth errors cleanly', () => {
    const rl = classifyDownloaderHttpFailure(429, { error: 'Too many requests' });
    assert.equal(rl.code, 'UPSTREAM_RATE_LIMIT');
    assert.equal(rl.retryable, true);

    const auth = classifyDownloaderHttpFailure(401, { error: 'Bad key' });
    assert.equal(auth.code, 'DOWNLOADER_AUTH_FAILED');
    assert.equal(auth.retryable, false);
  });

  it('guards Cloudinary ownership & protects UNMANAGED / IN-FLIGHT / PUBLISHED records appropriately', () => {
    assert.equal(buildOwnedPublicId('IG-10', 2, 'C8Code'), 'instaops-v2/IG-10/item_2_C8Code');
    assert.equal(buildOwnedPublicId('..bad', 0, 'x'), 'instaops-v2/__bad/item_0_x');

    const draft = normalizeContentRecord({ post_id: 'IG-10', status: 'DRAFT' });
    const publishing = normalizeContentRecord({ post_id: 'IG-LOCK', status: 'PUBLISHING' });
    const published = normalizeContentRecord({ post_id: 'IG-PUB', status: 'PUBLISHED', published_id: '180123' });

    const unmanaged = normalizeMediaAssetRecord({
      internal_asset_id: 'ast_old',
      post_id: 'IG-10',
      cloudinary_public_id: '',
      storage_status: 'UNMANAGED',
    });
    assert.throws(() => assertDeletableAssetOwnership(unmanaged, draft), /UNMANAGED|authoritative Cloudinary/i);

    const managedOnPublishing = normalizeMediaAssetRecord({
      internal_asset_id: 'ast_lock',
      post_id: 'IG-LOCK',
      cloudinary_public_id: 'instaops-v2/IG-LOCK/item_0_src',
      secure_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1/x.mp4',
      storage_status: 'ACTIVE',
    });
    assert.throws(() => assertDeletableAssetOwnership(managedOnPublishing, publishing), /PUBLISHING/i);

    const managedOnPub = normalizeMediaAssetRecord({
      internal_asset_id: 'ast_pub',
      post_id: 'IG-PUB',
      cloudinary_public_id: 'instaops-v2/IG-PUB/item_0_src',
      secure_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1/pub.mp4',
      storage_status: 'ACTIVE',
    });
    assert.throws(() => assertPostDeletable(published, [managedOnPub]), /Archive instead/);

    const summary = summarizeDeletionOutcomes([
      { internal_asset_id: 'a1', public_id: 'p1', result: 'ok' },
      { internal_asset_id: 'a2', public_id: 'p2', result: 'not found' },
    ]);
    assert.equal(summary.allConfirmedGone, true);
    assert.deepEqual(summary.alreadyMissingIds, ['a2']);
  });
});
