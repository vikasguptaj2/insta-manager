import crypto from 'node:crypto';
import type {
  ContentRecord,
  MediaAssetRecord,
  N8nExecutionSummary,
  PostEligibility,
} from '../../types/instaops';
import { AppError } from '../errors/codes';
import { getConfig } from '../config/env';
import {
  DEFAULT_ACCOUNT_KEY,
  DEFAULT_IG_USER_ID,
  normalizeContentRecord,
  SCHEMA_VERSION,
  text,
} from './schema';
import { isInFlightStatus, isLockedRecord, isPublishedRecord } from './state-machine';

const ISO_WITH_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;

const IG_SOURCE_RE =
  /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})\/?(?:[?#][^\s]*)?$/i;

export const MAX_CAPTION_LENGTH = 2200;

/** Extract Instagram shortcode from standard p/reel/reels/tv URLs. */
export function extractSourceShortcode(url: string): string {
  const match = text(url).match(IG_SOURCE_RE);
  return match?.[1] ?? '';
}

export function canonicalizeInstagramUrl(rawUrl: string): string {
  const trimmed = text(rawUrl);
  const match = trimmed.match(IG_SOURCE_RE);
  if (!match?.[1]) return '';
  const isPost = /instagram\.com\/p\//i.test(trimmed);
  return `https://www.instagram.com/${isPost ? 'p' : 'reel'}/${match[1]}/`;
}

export function isValidCloudinaryDeliveryUrl(
  rawUrl: string,
  cloudName = getConfig().cloudinaryCloudName,
  mediaType?: 'REEL' | 'IMAGE' | 'CAROUSEL',
): boolean {
  const trimmed = text(rawUrl);
  if (!trimmed) return false;
  const escapedCloud = cloudName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `^https://res\\.cloudinary\\.com/${escapedCloud}/(?:video|image)/upload/[^\\s]+$`,
    'i',
  );
  if (!pattern.test(trimmed)) return false;
  if (mediaType === 'REEL') return trimmed.includes('/video/upload/');
  if (mediaType === 'IMAGE') return trimmed.includes('/image/upload/');
  return true;
}

export function parseHashtagsAndMentions(caption: string): { hashtags: string[]; mentions: string[] } {
  const hashtags = Array.from(
    new Set((caption.match(/#[A-Za-z0-9_\u00C0-\u024F\u0900-\u097F]+/g) ?? []).map((t) => t.toLowerCase())),
  );
  const mentions = Array.from(new Set((caption.match(/@[A-Za-z0-9_.]+/g) ?? []).map((m) => m.toLowerCase())));
  return { hashtags, mentions };
}

export function safeJsonParseArray(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function bumpRevision(current: string): string {
  const parsed = Number.parseInt(current, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? String(parsed + 1) : '2';
}

/** Deterministic review hash input matching remote n8n validation before publishing. */
export function buildReviewSnapshot(record: Partial<ContentRecord>): string {
  const pm = text(record.publish_mode).toUpperCase() === 'LATER' ? 'LATER' : 'NOW';
  const finalCaption = text(record.caption) || text(record.original_caption);
  return JSON.stringify([
    text(record.post_id),
    text(record.source_instagram_url),
    text(record.media_url),
    text(record.media_type),
    finalCaption,
    pm,
    pm === 'NOW' ? '' : text(record.publish_at),
    text(record.account_key) || DEFAULT_ACCOUNT_KEY,
    text(record.ig_user_id) || DEFAULT_IG_USER_ID,
    text(record.revision) || '1',
  ]);
}

export const MAX_SCHEDULE_HORIZON_MS = 90 * 86_400_000;

export function assertValidScheduleIso(publishAt: string, now = Date.now()): number {
  const trimmed = text(publishAt);
  if (!ISO_WITH_TZ_RE.test(trimmed)) {
    throw new AppError('SCHEDULE_CONFLICT', 'Scheduled publish time must be an ISO timestamp with timezone.', {
      httpStatus: 422,
    });
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new AppError('SCHEDULE_CONFLICT', 'Invalid scheduled date.', { httpStatus: 422 });
  }
  if (ms <= now) {
    throw new AppError('SCHEDULE_CONFLICT', 'Scheduled publish time must be in the future.', {
      httpStatus: 422,
    });
  }
  if (ms > now + MAX_SCHEDULE_HORIZON_MS) {
    throw new AppError(
      'SCHEDULE_CONFLICT',
      'Scheduled publish time cannot exceed 90 days in the future.',
      { httpStatus: 422 },
    );
  }
  return ms;
}

export function validateCaptionLength(caption: string, opts?: { allowEmpty?: boolean }): string {
  const value = String(caption ?? '');
  if (!opts?.allowEmpty && !value.trim()) {
    throw new AppError('INVALID_MEDIA_TYPE', 'Review and supply a caption before publishing.', {
      httpStatus: 422,
    });
  }
  if (value.length > MAX_CAPTION_LENGTH) {
    throw new AppError(
      'INVALID_MEDIA_TYPE',
      `Caption must be at most ${MAX_CAPTION_LENGTH} characters (currently ${value.length}).`,
      { httpStatus: 422 },
    );
  }
  return value;
}

export function extractionCooldown(
  rows: ContentRecord[],
  now = Date.now(),
): { blocked: boolean; until: string | null; unknown: boolean } {
  let until = 0;
  let unknown = false;
  for (const r of rows) {
    const err = String(r.error ?? '');
    const code = String(r.error_code ?? '');
    if (
      code !== 'UPSTREAM_RATE_LIMIT' &&
      !/\bRATE_LIMIT\b|rate limited anonymous access|Downloader\s+429\b/i.test(err)
    ) {
      continue;
    }
    const at = Date.parse(String(r.processed_at || r.updated_at || ''));
    const marker = err.match(/\bretry-until=(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/);
    const explicit = marker?.[1] ? Date.parse(marker[1]) : NaN;
    if (!Number.isFinite(at) && !Number.isFinite(explicit)) {
      unknown = true;
      continue;
    }
    until = Math.max(
      until,
      Number.isFinite(at) ? at + 3600_000 : 0,
      Number.isFinite(explicit) ? explicit : 0,
    );
  }
  return {
    blocked: unknown || until > now,
    until: until ? new Date(until).toISOString() : null,
    unknown,
  };
}

export function applyContentCreate(
  input: {
    post_id?: string;
    source_instagram_url: string;
    media_type?: 'REEL' | 'IMAGE' | 'CAROUSEL';
    original_caption?: string;
    caption?: string;
    authorized: boolean;
  },
  existingRows: ContentRecord[],
): ContentRecord {
  if (input.authorized !== true) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Confirm you own or have authorization to use this content.', {
      httpStatus: 403,
    });
  }
  const sourceCode = extractSourceShortcode(input.source_instagram_url);
  if (!sourceCode) {
    throw new AppError('INVALID_SOURCE_URL', 'Enter a valid Instagram Reel, Post, or TV URL.', {
      httpStatus: 422,
    });
  }
  const canonical = canonicalizeInstagramUrl(input.source_instagram_url);
  if (
    existingRows.some(
      (r) => r.status !== 'DELETED' && extractSourceShortcode(r.source_instagram_url) === sourceCode,
    )
  ) {
    throw new AppError('DUPLICATE_SOURCE', `Source ${sourceCode} already exists in the queue.`, {
      httpStatus: 409,
    });
  }

  const postId = text(input.post_id) || `IG-${Date.now().toString(36).toUpperCase()}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(postId)) {
    throw new AppError('INVALID_SOURCE_URL', 'Post ID must be 1–80 alphanumeric, dash, or underscore characters.', {
      httpStatus: 422,
    });
  }
  if (existingRows.some((r) => r.post_id === postId)) {
    throw new AppError('DUPLICATE_SOURCE', `Post ID ${postId} already exists.`, { httpStatus: 409 });
  }

  const orig = validateCaptionLength(input.original_caption ?? '', { allowEmpty: true });
  const final = validateCaptionLength(input.caption ?? '', { allowEmpty: true });
  const parsedTags = parseHashtagsAndMentions(final || orig);
  const now = new Date().toISOString();

  return normalizeContentRecord({
    id: crypto.randomUUID(),
    post_id: postId,
    source_instagram_url: canonical,
    media_url: '',
    media_type: input.media_type ?? 'REEL',
    original_caption: orig,
    caption: final,
    account_key: DEFAULT_ACCOUNT_KEY,
    ig_user_id: DEFAULT_IG_USER_ID,
    publish_mode: 'NOW',
    publish_at: '',
    status: 'DRAFT',
    published_id: '',
    published_url: '',
    error: '',
    processed_at: '',
    schema_version: SCHEMA_VERSION,
    source_id: sourceCode,
    canonical_url: canonical,
    caption_status: orig ? 'available' : 'unknown',
    caption_source: orig ? 'manual' : '',
    hashtags_json: JSON.stringify(parsedTags.hashtags),
    mentions_json: JSON.stringify(parsedTags.mentions),
    media_count: '0',
    image_count: '0',
    video_count: '0',
    revision: '1',
    approved_revision: '',
    retry_count: '0',
    created_at: now,
    updated_at: now,
  });
}

export function applyContentPatch(
  existing: ContentRecord,
  patch: {
    source_instagram_url?: string;
    caption?: string;
    allowEmptyCaption?: boolean;
    hashtags?: string[];
  },
  allRows: ContentRecord[],
): ContentRecord {
  if (isLockedRecord(existing)) {
    throw new AppError(
      'POST_LOCKED',
      `Post ${existing.post_id} is locked in status ${existing.status}; reconcile or archive instead.`,
      { httpStatus: 409 },
    );
  }
  if (isInFlightStatus(existing.status)) {
    throw new AppError('POST_LOCKED', `Post ${existing.post_id} has an active operation (${existing.status}).`, {
      httpStatus: 409,
    });
  }

  let sourceUrl = existing.source_instagram_url;
  let sourceId = existing.source_id || extractSourceShortcode(existing.source_instagram_url);
  let canonicalUrl = existing.canonical_url;

  if (patch.source_instagram_url !== undefined) {
    if (text(existing.media_url)) {
      const nextCode = extractSourceShortcode(patch.source_instagram_url);
      if (nextCode !== sourceId) {
        throw new AppError(
          'POST_LOCKED',
          'Cannot change source URL after Cloudinary media is stored. Delete stored media or create a new draft.',
          { httpStatus: 409 },
        );
      }
    } else {
      const nextCode = extractSourceShortcode(patch.source_instagram_url);
      if (!nextCode) {
        throw new AppError('INVALID_SOURCE_URL', 'Invalid Instagram URL.', { httpStatus: 422 });
      }
      if (
        allRows.some(
          (r) =>
            r.post_id !== existing.post_id &&
            r.status !== 'DELETED' &&
            extractSourceShortcode(r.source_instagram_url) === nextCode,
        )
      ) {
        throw new AppError('DUPLICATE_SOURCE', `Source ${nextCode} already exists in another record.`, {
          httpStatus: 409,
        });
      }
      sourceId = nextCode;
      canonicalUrl = canonicalizeInstagramUrl(patch.source_instagram_url);
      sourceUrl = canonicalUrl;
    }
  }

  let nextCaption = existing.caption;
  if (patch.caption !== undefined) {
    nextCaption = validateCaptionLength(patch.caption, {
      allowEmpty: patch.allowEmptyCaption === true || Boolean(text(existing.original_caption)),
    });
  }

  const mergedText = nextCaption || existing.original_caption;
  const parsedTags = parseHashtagsAndMentions(mergedText);
  const hashtags = patch.hashtags ? Array.from(new Set(patch.hashtags)) : parsedTags.hashtags;

  // Editing caption or source invalidates previous publication/schedule approval.
  const nextStatus = existing.status === 'SCHEDULED' || existing.status === 'READY' ? 'DRAFT' : existing.status;

  return {
    ...existing,
    source_instagram_url: sourceUrl,
    source_id: sourceId,
    canonical_url: canonicalUrl,
    caption: nextCaption,
    hashtags_json: JSON.stringify(hashtags),
    mentions_json: JSON.stringify(parsedTags.mentions),
    status: nextStatus,
    approved_revision: '',
    revision: bumpRevision(existing.revision),
    updated_at: new Date().toISOString(),
  };
}

/** Evaluate detailed eligibility and human-readable disabled reasons for every UI action. */
export function evaluatePostEligibility(
  row: ContentRecord,
  ctx: {
    rows: ContentRecord[];
    assets: MediaAssetRecord[];
    executions: N8nExecutionSummary[];
    canWrite: boolean;
    schedulingEnabled: boolean;
    livePublishEnabled: boolean;
    liveDeleteEnabled: boolean;
    demoMode: boolean;
    cooldown: { blocked: boolean; unknown: boolean; until: string | null };
    now?: number;
  },
): PostEligibility {
  const now = ctx.now ?? Date.now();
  const id = text(row.post_id);
  const code = extractSourceShortcode(row.source_instagram_url);
  const isDuplicateId = ctx.rows.filter((x) => text(x.post_id) === id && x.status !== 'DELETED').length > 1;
  const isDuplicateSource =
    Boolean(code) &&
    ctx.rows.some(
      (x) =>
        text(x.post_id) !== id &&
        x.status !== 'DELETED' &&
        extractSourceShortcode(x.source_instagram_url) === code,
    );
  const isDuplicate = isDuplicateId || isDuplicateSource;
  const isLocked = isLockedRecord(row);
  const activeAssets = ctx.assets.filter(
    (a) => a.post_id === id && a.storage_status === 'ACTIVE',
  );
  const mediaCount = Math.max(activeAssets.length, Number(row.media_count) || (row.media_url ? 1 : 0));
  const isCarousel = row.media_type === 'CAROUSEL' || mediaCount > 1;
  const hasStoredMedia = Boolean(text(row.media_url)) || activeAssets.length > 0;
  const finalCaption = text(row.caption) || text(row.original_caption);
  const hasActiveExecution = ctx.executions.some((e) => !e.finished);

  const dupReason = isDuplicateId
    ? 'Duplicate post ID in Google Sheets.'
    : 'Duplicate Instagram source shortcode in Google Sheets.';

  let extractReason = '';
  if (isPublishedRecord(row)) extractReason = 'Already published to Instagram.';
  else if (isLocked) extractReason = `Post is locked (${row.status}); reconcile or inspect execution first.`;
  else if (isDuplicate) extractReason = dupReason;
  else if (!code) extractReason = 'Provide a valid Instagram Reel or Image URL first.';
  else if (ctx.cooldown.blocked) extractReason = 'Upstream rate-limit cooldown active; previously stored posts can still publish.';
  else if (hasActiveExecution) extractReason = 'Wait for active n8n execution to finish.';
  else if (!ctx.canWrite) extractReason = 'Connect n8n workflows before extracting.';

  let publishReason = '';
  if (isPublishedRecord(row)) publishReason = 'Already published to Instagram.';
  else if (row.status === 'VERIFY_MANUALLY') publishReason = 'Uncertain previous publish outcome; run Reconcile in Recovery Center first.';
  else if (isLocked && row.status !== 'SCHEDULED') publishReason = `Post is locked (${row.status}).`;
  else if (isDuplicate) publishReason = dupReason;
  else if (isCarousel && activeAssets.length < 2) {
    publishReason = 'Carousel publishing requires 2 to 10 active media assets stored in Cloudinary.';
  } else if (isCarousel && activeAssets.length > 10) {
    publishReason = `Instagram limits Carousel posts to 10 items (currently ${activeAssets.length} active assets).`;
  } else if (!hasStoredMedia) publishReason = 'Extract & upload media to Cloudinary first.';
  else if (!finalCaption) publishReason = 'Review and provide a final or original caption first.';
  else if (finalCaption.length > MAX_CAPTION_LENGTH) publishReason = `Caption exceeds ${MAX_CAPTION_LENGTH} characters.`;
  else if (!['DRAFT', 'READY', 'SCHEDULED'].includes(row.status)) {
    publishReason = `Status ${row.status} must be reconciled or reset to DRAFT/READY before publishing.`;
  } else if (!ctx.demoMode && !ctx.livePublishEnabled) {
    publishReason = 'LIVE_PUBLISH_ENABLED is false (configure Supabase/Postgres locks and enable in settings/.env.local).';
  } else if (hasActiveExecution) publishReason = 'Wait for active n8n execution to finish.';
  else if (!ctx.canWrite) publishReason = 'Connect n8n workflows first.';

  let scheduleReason = publishReason;
  if (!scheduleReason && !ctx.demoMode && !ctx.schedulingEnabled) {
    scheduleReason = 'Scheduling is disabled (SCHEDULING_ENABLED=false).';
  }

  let cancelScheduleReason = '';
  if (row.status !== 'SCHEDULED') cancelScheduleReason = 'Post is not currently scheduled.';
  else if (hasActiveExecution) cancelScheduleReason = 'Wait for active execution to finish.';

  let editReason = '';
  if (isPublishedRecord(row)) editReason = 'Published records cannot be edited.';
  else if (isLocked) editReason = `Post is locked (${row.status}).`;
  else if (hasActiveExecution) editReason = 'Wait for active execution to finish.';

  let deleteMediaReason = '';
  if (isInFlightStatus(row.status) || row.status === 'VERIFY_MANUALLY') {
    deleteMediaReason = `Cannot delete media while status is ${row.status}.`;
  } else if (!hasStoredMedia) {
    deleteMediaReason = 'No active Cloudinary media associated with this post.';
  } else if (activeAssets.some((a) => !a.cloudinary_public_id || a.storage_status === 'UNMANAGED')) {
    deleteMediaReason = 'Legacy media lacks authoritative public_id; inspect/reconcile assets before deletion.';
  } else if (!ctx.demoMode && !ctx.liveDeleteEnabled) {
    deleteMediaReason = 'LIVE_DELETE_ENABLED is false.';
  } else if (hasActiveExecution) deleteMediaReason = 'Wait for active execution to finish.';

  let deletePostReason = '';
  if (isInFlightStatus(row.status) || row.status === 'VERIFY_MANUALLY' || row.status === 'DELETED') {
    deletePostReason = `Cannot delete record while status is ${row.status}.`;
  } else if (isPublishedRecord(row)) {
    deletePostReason = 'Published records are protected; use Archive to preserve audit history.';
  } else if (!ctx.demoMode && !ctx.liveDeleteEnabled) {
    deletePostReason = 'LIVE_DELETE_ENABLED is false.';
  } else if (hasActiveExecution) deletePostReason = 'Wait for active execution to finish.';

  let archiveReason = '';
  if (isInFlightStatus(row.status) || row.status === 'ARCHIVED' || row.status === 'DELETED') {
    archiveReason = `Cannot archive record in status ${row.status}.`;
  }

  let retryReason = '';
  if (row.status !== 'FAILED') retryReason = 'Retry is only available for FAILED posts.';
  else if (row.error_code === 'UNAUTHORIZED_CONTENT' || row.error_code === 'MEDIA_UNAVAILABLE') {
    retryReason = 'Permanent error cannot be automatically retried.';
  } else if (row.error_code === 'UPSTREAM_RATE_LIMIT' && ctx.cooldown.blocked) {
    retryReason = `Wait until cooldown expires (${ctx.cooldown.until ?? 'unknown'}).`;
  } else if (hasActiveExecution) retryReason = 'Wait for active execution to finish.';

  let reconcileReason = '';
  if (!['VERIFY_MANUALLY', 'PUBLISHING', 'DELETING', 'EXTRACTING', 'UPLOADING'].includes(row.status) && !text(row.container_id)) {
    reconcileReason = 'No unresolved execution, container, or uncertain outcome requires reconciliation.';
  } else if (now < 0) reconcileReason = '';

  return {
    isLocked,
    isDuplicateId,
    isDuplicateSource,
    isCarousel,
    extract: { enabled: !extractReason, reason: extractReason },
    publish: { enabled: !publishReason, reason: publishReason },
    schedule: { enabled: !scheduleReason, reason: scheduleReason },
    cancelSchedule: { enabled: !cancelScheduleReason, reason: cancelScheduleReason },
    edit: { enabled: !editReason, reason: editReason },
    deleteMedia: { enabled: !deleteMediaReason, reason: deleteMediaReason },
    deletePost: { enabled: !deletePostReason, reason: deletePostReason },
    archive: { enabled: !archiveReason, reason: archiveReason },
    retry: { enabled: !retryReason, reason: retryReason },
    reconcile: { enabled: !reconcileReason, reason: reconcileReason },
  };
}

export function computePostProgress(row: ContentRecord): {
  completed: number;
  total: number;
  label: string;
  stages: Array<{ key: string; label: string; done: boolean }>;
} {
  const hasMedia = Boolean(text(row.media_url));
  const hasCaption = Boolean(text(row.caption) || text(row.original_caption));
  const isApprovedOrScheduled = ['READY', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED'].includes(row.status);
  const isPublished = isPublishedRecord(row);
  const stages = [
    { key: 'draft', label: 'Record created', done: true },
    { key: 'media', label: 'Media stored on Cloudinary', done: hasMedia },
    { key: 'caption', label: 'Caption reviewed / available', done: hasCaption },
    { key: 'approved', label: 'Approved revision locked', done: isApprovedOrScheduled },
    { key: 'published', label: 'Published on Instagram', done: isPublished },
  ];
  const completed = stages.filter((s) => s.done).length;
  let label = `${completed}/5 · Ready to extract`;
  if (isPublished) label = '5/5 · Published';
  else if (row.status === 'VERIFY_MANUALLY') label = 'Verification required';
  else if (row.status === 'FAILED') label = `${completed}/5 · Failed (${row.error_code || 'inspect'})`;
  else if (row.status === 'PUBLISHING') label = 'Publishing container to Instagram';
  else if (row.status === 'EXTRACTING' || row.status === 'UPLOADING') label = `${row.status} in progress`;
  else if (row.status === 'SCHEDULED') label = '4/5 · Scheduled';
  else if (row.status === 'MEDIA_DELETED') label = 'Media deleted (record kept)';
  else if (row.status === 'ARCHIVED') label = 'Archived';
  else if (hasMedia && hasCaption) label = `${completed}/5 · Extracted · Ready to publish`;
  else if (hasMedia) label = `${completed}/5 · Media uploaded`;

  return { completed, total: 5, label, stages };
}
