import { AppError } from '../errors/codes';

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('INVALID_MEDIA_TYPE', 'Expected JSON object payload.', { httpStatus: 422 });
  }
  return raw as Record<string, unknown>;
}

function asOptionalString(val: unknown): string | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') {
    throw new AppError('INVALID_MEDIA_TYPE', 'Expected string field.', { httpStatus: 422 });
  }
  return val;
}

export interface CreatePostInput {
  post_id?: string;
  source_instagram_url: string;
  media_type?: 'REEL' | 'IMAGE' | 'CAROUSEL';
  original_caption?: string;
  caption?: string;
  authorized: boolean;
}

export function parseCreatePostInput(raw: unknown): CreatePostInput {
  const obj = asObject(raw);
  const url = asOptionalString(obj.source_instagram_url);
  if (!url || !url.trim()) {
    throw new AppError('INVALID_SOURCE_URL', 'source_instagram_url is required.', { httpStatus: 422 });
  }
  if (obj.authorized !== true) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Confirm authorized ownership/permission before creating a record.', {
      httpStatus: 403,
    });
  }
  const mtRaw = asOptionalString(obj.media_type)?.toUpperCase();
  const media_type = mtRaw === 'IMAGE' || mtRaw === 'REEL' || mtRaw === 'CAROUSEL' ? mtRaw : 'REEL';
  return {
    post_id: asOptionalString(obj.post_id),
    source_instagram_url: url,
    media_type,
    original_caption: asOptionalString(obj.original_caption),
    caption: asOptionalString(obj.caption),
    authorized: true,
  };
}

export interface PatchPostInput {
  source_instagram_url?: string;
  caption?: string;
  allowEmptyCaption?: boolean;
  hashtags?: string[];
}

export function parsePatchPostInput(raw: unknown): PatchPostInput {
  const obj = asObject(raw);
  const hashtags = Array.isArray(obj.hashtags)
    ? obj.hashtags.map((t) => String(t).trim()).filter(Boolean)
    : undefined;
  return {
    source_instagram_url: asOptionalString(obj.source_instagram_url),
    caption: asOptionalString(obj.caption),
    allowEmptyCaption: obj.allowEmptyCaption === true,
    hashtags,
  };
}

export interface ExtractPostInput {
  authorized: boolean;
  idempotencyKey?: string;
}

export function parseExtractPostInput(raw: unknown): ExtractPostInput {
  const obj = asObject(raw);
  if (obj.authorized !== true) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Confirm authorization to extract and store media.', {
      httpStatus: 403,
    });
  }
  return {
    authorized: true,
    idempotencyKey: asOptionalString(obj.idempotencyKey),
  };
}

export interface PublishPostInput {
  confirm: boolean;
  reviewedRevision: string;
  caption?: string;
  allowEmptyCaption?: boolean;
  idempotencyKey?: string;
}

export function parsePublishPostInput(raw: unknown): PublishPostInput {
  const obj = asObject(raw);
  if (obj.confirm !== true) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Explicit publish confirmation (confirm: true) is required.', {
      httpStatus: 403,
    });
  }
  const rev = asOptionalString(obj.reviewedRevision) ?? '';
  if (!rev.trim()) {
    throw new AppError('REVISION_CONFLICT', 'reviewedRevision is required to bind approval to exact reviewed content.', {
      httpStatus: 409,
    });
  }
  return {
    confirm: true,
    reviewedRevision: rev.trim(),
    caption: asOptionalString(obj.caption),
    allowEmptyCaption: obj.allowEmptyCaption === true,
    idempotencyKey: asOptionalString(obj.idempotencyKey),
  };
}

export interface SchedulePostInput extends PublishPostInput {
  publish_at: string;
}

export function parseSchedulePostInput(raw: unknown): SchedulePostInput {
  const base = parsePublishPostInput(raw);
  const obj = asObject(raw);
  const publishAt = asOptionalString(obj.publish_at);
  if (!publishAt || !publishAt.trim()) {
    throw new AppError('SCHEDULE_CONFLICT', 'publish_at UTC/ISO timestamp is required for scheduling.', {
      httpStatus: 422,
    });
  }
  return { ...base, publish_at: publishAt.trim() };
}

export interface DeleteConfirmInput {
  confirm: boolean;
  reason?: string;
}

export function parseDeleteConfirmInput(raw: unknown): DeleteConfirmInput {
  const obj = asObject(raw);
  if (obj.confirm !== true) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Explicit confirmation (confirm: true) is required before deletion.', {
      httpStatus: 403,
    });
  }
  return {
    confirm: true,
    reason: asOptionalString(obj.reason),
  };
}

export interface RetryOrReconcileInput {
  inspected: boolean;
  resolution?: 'CHECK_EXECUTION' | 'MARK_READY' | 'MARK_FAILED' | 'MARK_PUBLISHED' | 'RELEASE_LOCK';
  published_id?: string;
  published_url?: string;
  forceReleaseLock?: boolean;
}

export function parseRetryOrReconcileInput(raw: unknown): RetryOrReconcileInput {
  const obj = asObject(raw);
  const res = asOptionalString(obj.resolution);
  const allowed = ['CHECK_EXECUTION', 'MARK_READY', 'MARK_FAILED', 'MARK_PUBLISHED', 'RELEASE_LOCK'];
  if (res && !allowed.includes(res)) {
    throw new AppError('INVALID_MEDIA_TYPE', 'Invalid reconciliation resolution action.', { httpStatus: 422 });
  }
  return {
    inspected: obj.inspected === true,
    resolution: res as RetryOrReconcileInput['resolution'],
    published_id: asOptionalString(obj.published_id),
    published_url: asOptionalString(obj.published_url),
    forceReleaseLock: obj.forceReleaseLock === true,
  };
}
