import { AppError } from '../errors/codes';
import { getConfig } from '../config/env';

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MB

const LOCAL_HOSTS = new Set([
  'localhost:3000',
  '127.0.0.1:3000',
  'localhost',
  '127.0.0.1',
]);

interface RateBucket {
  timestamps: number[];
}

const rateBuckets = new Map<string, RateBucket>();

export const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

/** Enforce local-only loopback host, same-origin CSRF, and JSON content-type checks. */
export function assertLocalRequest(req: Request, opts?: { requireJson?: boolean }): void {
  const cfg = getConfig();
  if (cfg.flags.publicAccessEnabled) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      'Public access is disabled until session authentication is configured.',
      { httpStatus: 403 },
    );
  }

  const host = (req.headers.get('host') ?? '').trim().toLowerCase();
  const appHost = (() => {
    try {
      return new URL(cfg.appUrl).host.toLowerCase();
    } catch {
      return '127.0.0.1:3000';
    }
  })();

  if (!LOCAL_HOSTS.has(host) && host !== appHost) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Untrusted Host header.', { httpStatus: 403 });
  }

  const method = req.method.toUpperCase();
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const origin = req.headers.get('origin');
  if (isMutation || origin !== null) {
    const allowedOrigin = `http://${host}`;
    if (origin !== allowedOrigin) {
      throw new AppError('UNAUTHORIZED_CONTENT', 'Same-origin request required.', {
        httpStatus: 403,
      });
    }
  }

  const secFetchSite = req.headers.get('sec-fetch-site');
  if (secFetchSite === 'cross-site') {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Cross-site request rejected.', { httpStatus: 403 });
  }

  if (isMutation && opts?.requireJson !== false) {
    const contentType = req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (contentType !== 'application/json') {
      throw new AppError('INVALID_MEDIA_TYPE', 'application/json content type is required.', {
        httpStatus: 415,
      });
    }
  }
}

/** Read and byte-cap a JSON object body from a Web Request without buffering unbounded streams. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const declaredLen = req.headers.get('content-length');
  if (declaredLen !== null && (!/^\d+$/.test(declaredLen) || Number(declaredLen) > MAX_REQUEST_BODY_BYTES)) {
    throw new AppError('MEDIA_TOO_LARGE', 'Request payload exceeds 1 MB limit.', { httpStatus: 413 });
  }

  if (!req.body) {
    throw new AppError('INVALID_MEDIA_TYPE', 'JSON request body is required.', { httpStatus: 400 });
  }

  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel();
        throw new AppError('MEDIA_TOO_LARGE', 'Request payload exceeds 1 MB limit.', {
          httpStatus: 413,
        });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_MEDIA_TYPE', 'Malformed JSON request body.', { httpStatus: 400 });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INVALID_MEDIA_TYPE', 'JSON object payload is required.', { httpStatus: 400 });
  }

  return parsed as Record<string, unknown>;
}

/** In-memory sliding-window rate limiter for sensitive dashboard mutations. */
export function enforceRateLimit(
  bucketKey: string,
  maxRequests = 12,
  windowMs = 60_000,
  now = Date.now(),
): void {
  const existing = rateBuckets.get(bucketKey) ?? { timestamps: [] };
  const recent = existing.timestamps.filter((ts) => now - ts < windowMs);
  if (recent.length >= maxRequests) {
    throw new AppError(
      'UPSTREAM_RATE_LIMIT',
      'Too many sensitive requests in a short window; wait briefly before retrying.',
      { httpStatus: 429, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) },
    );
  }
  recent.push(now);
  rateBuckets.set(bucketKey, { timestamps: recent });
}

export function clearRateLimitBucketsForTest(): void {
  rateBuckets.clear();
}

/** Prevent path traversal or control characters on resource identifiers. */
export function validateSafeId(raw: string, label = 'ID'): string {
  const value = String(raw ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(value)) {
    throw new AppError('INVALID_SOURCE_URL', `Invalid ${label} format.`, { httpStatus: 400 });
  }
  return value;
}

/** Escape dangerous spreadsheet formula prefixes (=, +, -, @, tab, cr) in plain string cells. */
export function sanitizeSpreadsheetText(raw: unknown): string {
  const value = String(raw ?? '');
  if (!value) return '';
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}
