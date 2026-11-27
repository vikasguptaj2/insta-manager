import type {
  AccountRecord,
  CaptionStatus,
  ContentRecord,
  ContentStatus,
  ExecutionLogRecord,
  MediaAssetRecord,
  MediaType,
  PublishMode,
  StorageStatus,
} from '../../types/instaops';
import { sanitizeSpreadsheetText } from '../security/http-guard';

export const SCHEMA_VERSION = '2.0';
export const DEFAULT_ACCOUNT_KEY = 'A';
export const DEFAULT_IG_USER_ID = '17841453414532595';

/** Legacy 15-column order preserved verbatim for existing worksheet compatibility. */
export const LEGACY_MAIN_COLUMNS = [
  'post_id',
  'source_instagram_url',
  'media_url',
  'media_type',
  'original_caption',
  'caption',
  'account_key',
  'ig_user_id',
  'publish_mode',
  'publish_at',
  'status',
  'published_id',
  'published_url',
  'error',
  'processed_at',
] as const;

export const EXTENDED_MAIN_COLUMNS = [
  'schema_version',
  'source_id',
  'source_username',
  'source_kind',
  'canonical_url',
  'caption_status',
  'caption_source',
  'hashtags_json',
  'mentions_json',
  'media_count',
  'image_count',
  'video_count',
  'source_published_at',
  'source_like_count',
  'source_comment_count',
  'source_play_count',
  'source_metadata_json',
  'file_size_bytes',
  'revision',
  'approved_revision',
  'container_id',
  'published_at',
  'execution_id',
  'request_id',
  'retry_count',
  'error_code',
  'error_stage',
  'created_at',
  'updated_at',
  'extracted_at',
  'uploaded_at',
  'archived_at',
  'deleted_at',
  'post_uuid',
  'child_container_ids',
  'sheets_sync_status',
  'sheets_synced_at',
] as const;

export const MAIN_SHEET_COLUMNS = [...LEGACY_MAIN_COLUMNS, ...EXTENDED_MAIN_COLUMNS] as const;

export const MEDIA_ASSETS_COLUMNS = [
  'internal_asset_id',
  'post_id',
  'media_index',
  'media_type',
  'source_expires_at',
  'cloudinary_public_id',
  'cloudinary_asset_id',
  'secure_url',
  'thumbnail_url',
  'resource_type',
  'delivery_type',
  'format',
  'file_size_bytes',
  'width',
  'height',
  'duration',
  'storage_status',
  'created_at',
  'updated_at',
  'deleted_at',
  'error',
  'asset_uuid',
  'post_uuid',
  'ig_child_container_id',
] as const;

export const EXECUTION_LOGS_COLUMNS = [
  'log_id',
  'request_id',
  'execution_id',
  'workflow_id',
  'workflow_name',
  'post_id',
  'operation',
  'trigger_source',
  'stage',
  'status',
  'started_at',
  'finished_at',
  'duration_ms',
  'error_code',
  'error_message',
  'retryable',
  'created_at',
] as const;

export const ACCOUNTS_COLUMNS = [
  'account_key',
  'account_label',
  'ig_user_id',
  'enabled',
  'created_at',
  'updated_at',
] as const;

const VALID_CONTENT_STATUSES = new Set<ContentStatus>([
  'DRAFT',
  'EXTRACTING',
  'UPLOADING',
  'READY',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'VERIFY_MANUALLY',
  'ARCHIVED',
  'DELETING',
  'MEDIA_DELETED',
  'DELETED',
]);

const VALID_CAPTION_STATUSES = new Set<CaptionStatus>([
  'available',
  'empty',
  'unavailable',
  'unknown',
]);

export function text(v: unknown): string {
  return String(v ?? '').trim();
}

const UNSAFE_NUMERIC_STR_RE = /^\s*(?:[+-]?\d+(?:\.\d+)?e[+-]?\d+|UNSAFE_NUMERIC_ID)\s*$/i;
const FORMULA_PREFIX_RE = /^[=+@-]/;

function preserveNumericId(raw: unknown): string {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? String(raw) : 'UNSAFE_NUMERIC_ID';
  }
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (UNSAFE_NUMERIC_STR_RE.test(s) || FORMULA_PREFIX_RE.test(s)) {
    return 'UNSAFE_NUMERIC_ID';
  }
  return s;
}

function normalizeStatus(raw: unknown): ContentStatus {
  const upper = text(raw).toUpperCase();
  if (upper === 'ERROR') return 'FAILED';
  if (upper === 'NEW') return 'READY';
  if (upper === 'INGESTING') return 'EXTRACTING';
  if (upper === 'PROCESSING') return 'PUBLISHING';
  if (VALID_CONTENT_STATUSES.has(upper as ContentStatus)) {
    return upper as ContentStatus;
  }
  return 'DRAFT';
}

function normalizeMediaType(raw: unknown): MediaType {
  const upper = text(raw).toUpperCase();
  if (upper === 'IMAGE' || upper === 'REEL' || upper === 'CAROUSEL') return upper;
  return 'REEL';
}

function normalizePublishMode(raw: unknown): PublishMode {
  return text(raw).toUpperCase() === 'LATER' ? 'LATER' : 'NOW';
}

function normalizeCaptionStatus(raw: unknown): CaptionStatus {
  const lower = text(raw).toLowerCase() as CaptionStatus;
  return VALID_CAPTION_STATUSES.has(lower) ? lower : 'unknown';
}

/** Normalize any raw spreadsheet row into a strictly typed v2.0 ContentRecord. */
export function normalizeContentRecord(row: Record<string, unknown>): ContentRecord {
  const now = new Date().toISOString();
  const base: Record<string, string> = {};
  let unsafeNumeric = false;
  for (const col of MAIN_SHEET_COLUMNS) {
    if (col === 'ig_user_id' || col === 'published_id' || col === 'container_id') {
      base[col] = preserveNumericId(row[col]);
      if (base[col] === 'UNSAFE_NUMERIC_ID') unsafeNumeric = true;
    } else if (col === 'status') {
      base[col] = normalizeStatus(row[col]);
    } else if (col === 'media_type') {
      base[col] = normalizeMediaType(row[col]);
    } else if (col === 'publish_mode') {
      base[col] = normalizePublishMode(row[col]);
    } else if (col === 'caption_status') {
      base[col] = normalizeCaptionStatus(row[col]);
    } else {
      base[col] = String(row[col] ?? '');
    }
  }

  const out: ContentRecord = {
    ...(base as unknown as ContentRecord),
    id: text(row.id) || text(base.post_uuid) || undefined,
    schema_version: text(base.schema_version) || SCHEMA_VERSION,
    account_key: text(base.account_key) || DEFAULT_ACCOUNT_KEY,
    ig_user_id: text(base.ig_user_id) || DEFAULT_IG_USER_ID,
    error_code:
      text(base.error_code) || (unsafeNumeric ? 'UNSAFE_NUMERIC_ID' : ''),
    error:
      text(base.error) ||
      (unsafeNumeric
        ? 'Potential numeric ID corruption detected (scientific notation, formula prefix, or unsafe precision).'
        : ''),
    revision: /^\d+$/.test(text(base.revision)) ? text(base.revision) : '1',
    retry_count: /^\d+$/.test(text(base.retry_count)) ? text(base.retry_count) : '0',
    media_count: /^\d+$/.test(text(base.media_count)) ? text(base.media_count) : base.media_url ? '1' : '0',
    image_count: /^\d+$/.test(text(base.image_count)) ? text(base.image_count) : '0',
    video_count: /^\d+$/.test(text(base.video_count)) ? text(base.video_count) : '0',
    created_at: text(base.created_at) || now,
    updated_at: text(base.updated_at) || now,
  };
  return out;
}

/** Serialize ContentRecord with formula-injection safety for text cells written to Google Sheets. */
export function toSafeSheetRow(record: ContentRecord): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const col of MAIN_SHEET_COLUMNS) {
    let val: string;
    if (col === 'post_uuid') {
      val = record.id ?? '';
    } else {
      val = String((record as unknown as Record<string, unknown>)[col] ?? '');
    }
    safe[col] = ['original_caption', 'caption', 'error', 'source_username'].includes(col)
      ? sanitizeSpreadsheetText(val)
      : val;
  }
  return safe;
}

export function normalizeMediaAssetRecord(row: Record<string, unknown>): MediaAssetRecord {
  const toNumOrNull = (val: unknown): number | null => {
    const n = Number(val);
    return val !== '' && val !== null && val !== undefined && Number.isFinite(n) ? n : null;
  };
  const statusRaw = text(row.storage_status).toUpperCase() as StorageStatus;
  const storageStatus: StorageStatus = ['ACTIVE', 'DELETE_PENDING', 'DELETED', 'PARTIAL_DELETE', 'UNMANAGED', 'FAILED'].includes(
    statusRaw,
  )
    ? statusRaw
    : 'ACTIVE';

  const deliveryRaw = text(row.delivery_type).toLowerCase();
  const deliveryType =
    deliveryRaw === 'authenticated' || deliveryRaw === 'private' ? deliveryRaw : 'upload';

  return {
    internal_asset_id: text(row.internal_asset_id),
    post_id: text(row.post_id),
    media_index: Number.isFinite(Number(row.media_index)) ? Number(row.media_index) : 0,
    media_type: text(row.media_type).toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE',
    source_expires_at: text(row.source_expires_at),
    cloudinary_public_id: text(row.cloudinary_public_id),
    cloudinary_asset_id: text(row.cloudinary_asset_id),
    secure_url: text(row.secure_url),
    thumbnail_url: text(row.thumbnail_url),
    resource_type: text(row.resource_type).toLowerCase() === 'video' ? 'video' : 'image',
    delivery_type: deliveryType,
    format: text(row.format).toLowerCase(),
    file_size_bytes: Math.max(0, Number(row.file_size_bytes) || 0),
    width: toNumOrNull(row.width),
    height: toNumOrNull(row.height),
    duration: toNumOrNull(row.duration),
    storage_status: storageStatus,
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
    deleted_at: text(row.deleted_at),
    error: text(row.error),
  };
}

export function normalizeExecutionLogRecord(row: Record<string, unknown>): ExecutionLogRecord {
  const dur = Number(row.duration_ms);
  return {
    log_id: text(row.log_id),
    request_id: text(row.request_id),
    execution_id: text(row.execution_id),
    workflow_id: text(row.workflow_id),
    workflow_name: text(row.workflow_name),
    post_id: text(row.post_id),
    operation: text(row.operation),
    trigger_source: text(row.trigger_source) || 'DASHBOARD',
    stage: text(row.stage),
    status: text(row.status),
    started_at: text(row.started_at),
    finished_at: text(row.finished_at),
    duration_ms: row.duration_ms !== '' && Number.isFinite(dur) ? dur : null,
    error_code: text(row.error_code),
    error_message: text(row.error_message),
    retryable: String(row.retryable).toLowerCase() === 'true',
    created_at: text(row.created_at),
  };
}

export function normalizeAccountRecord(row: Record<string, unknown>): AccountRecord {
  return {
    account_key: text(row.account_key) || DEFAULT_ACCOUNT_KEY,
    account_label: text(row.account_label) || '@vikas.sphere',
    ig_user_id: preserveNumericId(row.ig_user_id) || DEFAULT_IG_USER_ID,
    enabled: String(row.enabled).toLowerCase() !== 'false',
    created_at: text(row.created_at),
    updated_at: text(row.updated_at),
  };
}
