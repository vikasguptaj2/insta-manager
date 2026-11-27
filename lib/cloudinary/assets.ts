import type { ContentRecord, MediaAssetRecord } from '../../types/instaops';
import { AppError } from '../errors/codes';
import { assertConfiguredCloudinaryUrl } from '../security/ssrf';
import { isInFlightStatus, isLockedRecord } from '../domain/state-machine';

export const APP_MEDIA_NAMESPACE = 'instaops-v2';

/** Build collision-safe Cloudinary folder & public_id namespace scoped to this application and post. */
export function buildOwnedPublicId(postId: string, mediaIndex: number, shortcode: string): string {
  const safePost = postId.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeCode = (shortcode || 'src').replace(/[^A-Za-z0-9_-]/g, '_');
  return `${APP_MEDIA_NAMESPACE}/${safePost}/item_${mediaIndex}_${safeCode}`;
}

export interface CloudinaryUploadApiPayload {
  public_id?: unknown;
  asset_id?: unknown;
  secure_url?: unknown;
  resource_type?: unknown;
  type?: unknown;
  format?: unknown;
  bytes?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  error?: { message?: unknown } | unknown;
}

/** Validate and convert an authoritative Cloudinary Upload API response into a MediaAssetRecord. */
export function buildVerifiedAssetFromUpload(
  postId: string,
  mediaIndex: number,
  expectedMediaType: 'IMAGE' | 'VIDEO',
  uploadPayload: CloudinaryUploadApiPayload,
  opts?: { sourceExpiresAt?: string; thumbnailUrl?: string; internalAssetId?: string },
): MediaAssetRecord {
  if (uploadPayload.error) {
    const msg =
      typeof uploadPayload.error === 'object' && uploadPayload.error !== null && 'message' in uploadPayload.error
        ? String((uploadPayload.error as { message?: unknown }).message)
        : String(uploadPayload.error);
    throw new AppError('CLOUDINARY_UPLOAD_FAILED', `Cloudinary upload failed: ${msg}`, { httpStatus: 502 });
  }

  const publicId = String(uploadPayload.public_id ?? '').trim();
  const assetId = String(uploadPayload.asset_id ?? '').trim();
  const secureUrl = String(uploadPayload.secure_url ?? '').trim();
  const resourceType = String(uploadPayload.resource_type ?? '').toLowerCase();

  if (!publicId || !assetId || !secureUrl) {
    throw new AppError(
      'CLOUDINARY_UPLOAD_FAILED',
      'Cloudinary response missing authoritative public_id, asset_id, or secure_url.',
      { httpStatus: 502 },
    );
  }

  const expectedResource = expectedMediaType === 'VIDEO' ? 'video' : 'image';
  if (resourceType !== expectedResource) {
    throw new AppError(
      'INVALID_MEDIA_TYPE',
      `Cloudinary returned resource_type=${resourceType}, expected ${expectedResource}.`,
      { httpStatus: 422 },
    );
  }

  assertConfiguredCloudinaryUrl(secureUrl);

  const now = new Date().toISOString();
  const deliveryRaw = String(uploadPayload.type ?? 'upload').toLowerCase();
  const deliveryType =
    deliveryRaw === 'authenticated' || deliveryRaw === 'private' ? deliveryRaw : 'upload';

  return {
    internal_asset_id: opts?.internalAssetId ?? `ast_${postId}_${mediaIndex}_${Date.now().toString(36)}`,
    post_id: postId,
    media_index: mediaIndex,
    media_type: expectedMediaType,
    source_expires_at: opts?.sourceExpiresAt ?? '',
    cloudinary_public_id: publicId,
    cloudinary_asset_id: assetId,
    secure_url: secureUrl,
    thumbnail_url: opts?.thumbnailUrl ?? '',
    resource_type: expectedResource,
    delivery_type: deliveryType,
    format: String(uploadPayload.format ?? '').toLowerCase(),
    file_size_bytes: Math.max(0, Number(uploadPayload.bytes) || 0),
    width: Number.isFinite(Number(uploadPayload.width)) ? Number(uploadPayload.width) : null,
    height: Number.isFinite(Number(uploadPayload.height)) ? Number(uploadPayload.height) : null,
    duration: Number.isFinite(Number(uploadPayload.duration)) ? Number(uploadPayload.duration) : null,
    storage_status: 'ACTIVE',
    created_at: now,
    updated_at: now,
    deleted_at: '',
    error: '',
  };
}

/** Verify browser-supplied asset deletion only targets verified application-owned records. */
export function assertDeletableAssetOwnership(
  asset: MediaAssetRecord,
  parentPost: ContentRecord | undefined,
): void {
  if (asset.storage_status === 'UNMANAGED' || !asset.cloudinary_public_id) {
    throw new AppError(
      'UNAUTHORIZED_CONTENT',
      `Asset ${asset.internal_asset_id} lacks authoritative Cloudinary ownership metadata and is read-only.`,
      { httpStatus: 409 },
    );
  }

  if (
    !asset.cloudinary_public_id.startsWith(`${APP_MEDIA_NAMESPACE}/`) &&
    !asset.cloudinary_public_id.startsWith('n8n-instagram-automation/')
  ) {
    throw new AppError(
      'UNAUTHORIZED_CONTENT',
      `Asset ${asset.cloudinary_public_id} falls outside application-owned Cloudinary namespaces.`,
      { httpStatus: 403 },
    );
  }

  assertConfiguredCloudinaryUrl(asset.secure_url);

  if (parentPost) {
    if (isInFlightStatus(parentPost.status) || parentPost.status === 'VERIFY_MANUALLY') {
      throw new AppError(
        'POST_LOCKED',
        `Cannot delete media while parent post ${parentPost.post_id} is ${parentPost.status}.`,
        { httpStatus: 409 },
      );
    }
  }
}

export function assertPostDeletable(post: ContentRecord, assets: MediaAssetRecord[]): void {
  if (isLockedRecord(post)) {
    throw new AppError(
      'POST_LOCKED',
      `Post ${post.post_id} (${post.status}) is protected from record deletion. Use Archive instead.`,
      { httpStatus: 409 },
    );
  }
  const activeOwnedAssets = assets.filter(
    (a) => a.post_id === post.post_id && a.storage_status === 'ACTIVE',
  );
  for (const asset of activeOwnedAssets) {
    assertDeletableAssetOwnership(asset, post);
  }
}

export interface DeletionBatchOutcome {
  succeededIds: string[];
  alreadyMissingIds: string[];
  failed: Array<{ internal_asset_id: string; public_id: string; error: string }>;
  allConfirmedGone: boolean;
}

/** Reconcile Cloudinary destroy responses across single or 9-item carousel asset arrays. */
export function summarizeDeletionOutcomes(
  outcomes: Array<{
    internal_asset_id: string;
    public_id: string;
    result?: string;
    error?: string;
  }>,
): DeletionBatchOutcome {
  const succeededIds: string[] = [];
  const alreadyMissingIds: string[] = [];
  const failed: Array<{ internal_asset_id: string; public_id: string; error: string }> = [];

  for (const item of outcomes) {
    const res = String(item.result ?? '').toLowerCase();
    if (!item.error && res === 'ok') {
      succeededIds.push(item.internal_asset_id);
    } else if (!item.error && res === 'not found') {
      alreadyMissingIds.push(item.internal_asset_id);
    } else {
      failed.push({
        internal_asset_id: item.internal_asset_id,
        public_id: item.public_id,
        error: item.error || `Unexpected destroy result: ${res || 'unknown'}`,
      });
    }
  }

  return {
    succeededIds,
    alreadyMissingIds,
    failed,
    allConfirmedGone: failed.length === 0,
  };
}
