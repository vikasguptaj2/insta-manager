export const ERROR_CODES = [
  'INVALID_SOURCE_URL',
  'DUPLICATE_SOURCE',
  'UNAUTHORIZED_CONTENT',
  'DOWNLOADER_UNAVAILABLE',
  'DOWNLOADER_AUTH_FAILED',
  'MEDIA_UNAVAILABLE',
  'MEDIA_URL_EXPIRED',
  'UPSTREAM_RATE_LIMIT',
  'MEDIA_TOO_LARGE',
  'INVALID_MEDIA_TYPE',
  'CLOUDINARY_UPLOAD_FAILED',
  'CLOUDINARY_DELETE_FAILED',
  'SHEETS_READ_FAILED',
  'SHEETS_WRITE_FAILED',
  'POST_NOT_FOUND',
  'POST_LOCKED',
  'LOCK_ACQUISITION_FAILED',
  'REVISION_CONFLICT',
  'SCHEDULE_CONFLICT',
  'INSTAGRAM_AUTH_FAILED',
  'INSTAGRAM_CONTAINER_FAILED',
  'INSTAGRAM_PROCESSING_TIMEOUT',
  'INSTAGRAM_PUBLISH_FAILED',
  'PUBLISH_OUTCOME_UNKNOWN',
  'DELETE_OUTCOME_UNKNOWN',
  'CONFIGURATION_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type FailureKind =
  | 'definite'
  | 'retryable'
  | 'permanent'
  | 'pending'
  | 'partial'
  | 'unknown';

export interface StructuredErrorPayload {
  code: ErrorCode;
  message: string;
  kind: FailureKind;
  retryable: boolean;
  retryAfterSeconds?: number;
  details?: Record<string, unknown>;
}

const FAILURE_META: Record<ErrorCode, { status: number; kind: FailureKind; retryable: boolean }> = {
  INVALID_SOURCE_URL: { status: 422, kind: 'permanent', retryable: false },
  DUPLICATE_SOURCE: { status: 409, kind: 'permanent', retryable: false },
  UNAUTHORIZED_CONTENT: { status: 403, kind: 'permanent', retryable: false },
  DOWNLOADER_UNAVAILABLE: { status: 502, kind: 'retryable', retryable: true },
  DOWNLOADER_AUTH_FAILED: { status: 502, kind: 'permanent', retryable: false },
  MEDIA_UNAVAILABLE: { status: 404, kind: 'permanent', retryable: false },
  MEDIA_URL_EXPIRED: { status: 410, kind: 'retryable', retryable: true },
  UPSTREAM_RATE_LIMIT: { status: 429, kind: 'retryable', retryable: true },
  MEDIA_TOO_LARGE: { status: 413, kind: 'permanent', retryable: false },
  INVALID_MEDIA_TYPE: { status: 422, kind: 'permanent', retryable: false },
  CLOUDINARY_UPLOAD_FAILED: { status: 502, kind: 'retryable', retryable: true },
  CLOUDINARY_DELETE_FAILED: { status: 502, kind: 'partial', retryable: false },
  SHEETS_READ_FAILED: { status: 502, kind: 'retryable', retryable: true },
  SHEETS_WRITE_FAILED: { status: 502, kind: 'retryable', retryable: true },
  POST_NOT_FOUND: { status: 404, kind: 'definite', retryable: false },
  POST_LOCKED: { status: 409, kind: 'definite', retryable: false },
  LOCK_ACQUISITION_FAILED: { status: 409, kind: 'retryable', retryable: true },
  REVISION_CONFLICT: { status: 409, kind: 'definite', retryable: false },
  SCHEDULE_CONFLICT: { status: 409, kind: 'definite', retryable: false },
  INSTAGRAM_AUTH_FAILED: { status: 502, kind: 'permanent', retryable: false },
  INSTAGRAM_CONTAINER_FAILED: { status: 502, kind: 'definite', retryable: false },
  INSTAGRAM_PROCESSING_TIMEOUT: { status: 504, kind: 'unknown', retryable: false },
  INSTAGRAM_PUBLISH_FAILED: { status: 502, kind: 'definite', retryable: false },
  PUBLISH_OUTCOME_UNKNOWN: { status: 502, kind: 'unknown', retryable: false },
  DELETE_OUTCOME_UNKNOWN: { status: 502, kind: 'unknown', retryable: false },
  CONFIGURATION_ERROR: { status: 500, kind: 'definite', retryable: false },
};

/** Scrub tokens, secrets, headers, and stack traces from arbitrary data before display/logging. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') {
    return value
      .slice(0, 3000)
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
      .replace(/(api[_-]?key|token|secret|password)=([^&\s]+)/gi, '$1=[redacted]');
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSensitive(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 80);
    for (const [k, v] of entries) {
      if (/authorization|token|secret|credential|headers|binary|stack|password|api.?key|cookie/i.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = redactSensitive(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly kind: FailureKind;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: {
      httpStatus?: number;
      retryAfterSeconds?: number;
      details?: Record<string, unknown>;
    },
  ) {
    super(String(redactSensitive(message)));
    this.name = 'AppError';
    const meta = FAILURE_META[code];
    this.code = code;
    this.httpStatus = opts?.httpStatus ?? meta.status;
    this.kind = meta.kind;
    this.retryable = meta.retryable;
    this.retryAfterSeconds = opts?.retryAfterSeconds;
    this.details = opts?.details
      ? (redactSensitive(opts.details) as Record<string, unknown>)
      : undefined;
  }

  toPayload(): StructuredErrorPayload {
    return {
      code: this.code,
      message: this.message,
      kind: this.kind,
      retryable: this.retryable,
      ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new AppError('CONFIGURATION_ERROR', err.message || 'Unexpected internal error', {
      httpStatus: 500,
    });
  }
  return new AppError('CONFIGURATION_ERROR', String(err || 'Unexpected error'), { httpStatus: 500 });
}

export function httpStatusForCode(code: ErrorCode): number {
  return FAILURE_META[code].status;
}

/** True when retrying automatically must never occur because external state may already be applied. */
export function isUnknownOutcomeCode(code: ErrorCode): boolean {
  return (
    code === 'PUBLISH_OUTCOME_UNKNOWN' ||
    code === 'DELETE_OUTCOME_UNKNOWN' ||
    code === 'INSTAGRAM_PROCESSING_TIMEOUT'
  );
}
