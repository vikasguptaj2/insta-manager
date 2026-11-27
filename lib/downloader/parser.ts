import type { CaptionStatus, DownloaderMediaItem, DownloaderResolveResult } from '../../types/instaops';
import { AppError } from '../errors/codes';
import { assertSafeExternalUrl } from '../security/ssrf';

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB ceiling

/** Classify upstream HTTP failures from the hosted Vercel downloader. */
export function classifyDownloaderHttpFailure(
  statusCode: number,
  body: Record<string, unknown> | null,
  headers?: Headers | Record<string, string>,
): AppError {
  const codeField = String(body?.code ?? '').toUpperCase();
  const message = String(body?.error ?? body?.message ?? `Downloader HTTP ${statusCode}`).slice(0, 320);

  let retryAfterSeconds: number | undefined;
  const retryRaw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (retryRaw) {
    if (/^\d+$/.test(retryRaw.trim())) {
      retryAfterSeconds = Number(retryRaw.trim());
    } else {
      const parsedDate = Date.parse(retryRaw);
      if (Number.isFinite(parsedDate)) {
        retryAfterSeconds = Math.max(1, Math.ceil((parsedDate - Date.now()) / 1000));
      }
    }
  } else if (typeof body?.retry_after_seconds === 'number' && body.retry_after_seconds > 0) {
    retryAfterSeconds = Math.ceil(body.retry_after_seconds);
  }

  if (statusCode === 401 || statusCode === 403 && /auth|token|key|unauthori/i.test(message)) {
    return new AppError('DOWNLOADER_AUTH_FAILED', `Downloader authentication failed (HTTP ${statusCode}).`, {
      httpStatus: 502,
    });
  }
  if (statusCode === 429 || codeField === 'RATE_LIMIT' || /rate limit/i.test(message)) {
    return new AppError(
      'UPSTREAM_RATE_LIMIT',
      `Downloader rate-limited by Instagram (HTTP ${statusCode}): ${message}`,
      { httpStatus: 429, retryAfterSeconds: retryAfterSeconds ?? 3600 },
    );
  }
  if (statusCode === 403) {
    return new AppError('UNAUTHORIZED_CONTENT', `Source inaccessible or private (${message}).`, {
      httpStatus: 403,
    });
  }
  if (statusCode === 404) {
    return new AppError('MEDIA_UNAVAILABLE', 'Instagram source post or Reel was not found.', {
      httpStatus: 404,
    });
  }
  if (statusCode === 422) {
    return new AppError('INVALID_SOURCE_URL', `Invalid Instagram source payload: ${message}`, {
      httpStatus: 422,
    });
  }
  return new AppError('DOWNLOADER_UNAVAILABLE', `Hosted downloader error (HTTP ${statusCode}): ${message}`, {
    httpStatus: 502,
  });
}

function normalizeNumOrNull(val: unknown): number | null {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeCaptionStatus(raw: unknown, caption: string): CaptionStatus {
  const lower = String(raw ?? '').trim().toLowerCase();
  if (lower === 'available' || lower === 'empty' || lower === 'unavailable') return lower;
  return caption ? 'available' : 'unknown';
}

/** Validate and normalize /api/n8n/resolve response payload with strict SSRF, expiry, and size bounds. */
export async function parseDownloaderResolveResponse(
  rawBody: unknown,
  opts?: { skipDnsLookup?: boolean; now?: number },
): Promise<DownloaderResolveResult> {
  const now = opts?.now ?? Date.now();
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new AppError('DOWNLOADER_UNAVAILABLE', 'Invalid non-object response from downloader.', {
      httpStatus: 502,
    });
  }

  const obj = rawBody as Record<string, unknown>;
  if (obj.ok !== true || String(obj.status ?? '').toLowerCase() !== 'ready') {
    throw classifyDownloaderHttpFailure(502, obj);
  }

  if (String(obj.platform ?? '').toLowerCase() !== 'instagram') {
    throw new AppError('INVALID_MEDIA_TYPE', 'Unexpected platform in downloader payload.', { httpStatus: 422 });
  }

  const rawMedia = obj.media;
  if (!Array.isArray(rawMedia) || rawMedia.length === 0) {
    throw new AppError('MEDIA_UNAVAILABLE', 'Downloader returned ready status with zero media items.', {
      httpStatus: 404,
    });
  }

  const validatedMedia: DownloaderMediaItem[] = [];
  for (let i = 0; i < rawMedia.length; i++) {
    const item = rawMedia[i] as Record<string, unknown>;
    if (!item || typeof item !== 'object') {
      throw new AppError('INVALID_MEDIA_TYPE', `Invalid media item at index ${i}.`, { httpStatus: 422 });
    }
    const itemType = String(item.type ?? '').toLowerCase();
    if (itemType !== 'image' && itemType !== 'video') {
      throw new AppError('INVALID_MEDIA_TYPE', `Unsupported media type "${itemType}" at index ${i}.`, {
        httpStatus: 422,
      });
    }

    const mediaUrl = String(item.url ?? '').trim();
    await assertSafeExternalUrl(mediaUrl, { skipDnsLookup: opts?.skipDnsLookup });

    let thumbUrl: string | undefined;
    if (item.thumbnailUrl) {
      thumbUrl = String(item.thumbnailUrl).trim();
      await assertSafeExternalUrl(thumbUrl, { skipDnsLookup: opts?.skipDnsLookup });
    }

    const expiresAtRaw = item.expiresAt ? String(item.expiresAt).trim() : null;
    if (expiresAtRaw) {
      const expMs = Date.parse(expiresAtRaw);
      if (!Number.isFinite(expMs) || expMs <= now) {
        throw new AppError('MEDIA_URL_EXPIRED', `Signed media URL at index ${i} is already expired (${expiresAtRaw}).`, {
          httpStatus: 410,
        });
      }
    }

    const sizeBytes = normalizeNumOrNull(item.fileSizeBytes);
    if (sizeBytes !== null && sizeBytes > MAX_MEDIA_BYTES) {
      throw new AppError('MEDIA_TOO_LARGE', `Media item at index ${i} exceeds 100 MB ceiling (${sizeBytes} bytes).`, {
        httpStatus: 413,
      });
    }

    validatedMedia.push({
      type: itemType,
      url: mediaUrl,
      ...(thumbUrl ? { thumbnailUrl: thumbUrl } : {}),
      fileSizeBytes: sizeBytes,
      expiresAt: expiresAtRaw,
      width: normalizeNumOrNull(item.width),
      height: normalizeNumOrNull(item.height),
    });
  }

  const caption = String(obj.caption ?? '');
  const captionStatus = normalizeCaptionStatus(obj.captionStatus, caption);
  const meta = (obj.postMetadata ?? {}) as Record<string, unknown>;

  return {
    ok: true,
    status: 'ready',
    platform: 'instagram',
    kind: String(obj.kind ?? (validatedMedia.length > 1 ? 'carousel' : validatedMedia[0]?.type === 'video' ? 'reel' : 'image')),
    canonicalUrl: String(obj.canonicalUrl ?? ''),
    embedUrl: obj.embedUrl ? String(obj.embedUrl) : undefined,
    sourceUsername: obj.sourceUsername ? String(obj.sourceUsername) : undefined,
    sourceId: String(obj.sourceId ?? ''),
    caption,
    captionSource: String(obj.captionSource ?? ''),
    captionStatus,
    hashtags: Array.isArray(obj.hashtags) ? obj.hashtags.map(String) : [],
    mentions: Array.isArray(obj.mentions) ? obj.mentions.map(String) : [],
    postMetadata: {
      mediaCount: normalizeNumOrNull(meta.mediaCount) ?? validatedMedia.length,
      imageCount:
        normalizeNumOrNull(meta.imageCount) ??
        validatedMedia.filter((m) => m.type === 'image').length,
      videoCount:
        normalizeNumOrNull(meta.videoCount) ??
        validatedMedia.filter((m) => m.type === 'video').length,
      publishedAt: meta.publishedAt ? String(meta.publishedAt) : null,
      likeCount: normalizeNumOrNull(meta.likeCount),
      commentCount: normalizeNumOrNull(meta.commentCount),
      playCount: normalizeNumOrNull(meta.playCount),
      width: normalizeNumOrNull(meta.width),
      height: normalizeNumOrNull(meta.height),
      fileSizeBytes: normalizeNumOrNull(meta.fileSizeBytes),
    },
    media: validatedMedia,
  };
}
