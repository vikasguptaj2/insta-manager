import { getConfig } from '../config/env';
import { AppError } from '../errors/codes';
import { assertSafeExternalUrl } from '../security/ssrf';
import { classifyDownloaderHttpFailure, parseDownloaderResolveResponse } from './parser';
import type { DownloaderResolveResult } from '../../types/instaops';

export interface DownloaderHealthResult {
  ok: boolean;
  statusCode: number;
  latencyMs: number;
  detail: string;
}

/** Check GET /api/health on configured Vercel Instagram downloader. */
export async function checkDownloaderHealth(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<DownloaderHealthResult> {
  const cfg = getConfig();
  if (cfg.demoMode) {
    return { ok: true, statusCode: 200, latencyMs: 5, detail: 'Demo mode mock health OK' };
  }
  await assertSafeExternalUrl(cfg.downloaderBaseUrl, {
    allowedHosts: [new URL(cfg.downloaderBaseUrl).hostname],
    allowHttpLocalhost: true,
    skipDnsLookup: true,
  });

  const started = Date.now();
  try {
    const res = await fetchImpl(`${cfg.downloaderBaseUrl}/api/health`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return { ok: false, statusCode: res.status, latencyMs, detail: `Health returned HTTP ${res.status}` };
    }
    return { ok: true, statusCode: res.status, latencyMs, detail: 'Hosted downloader reachable' };
  } catch (err) {
    const latencyMs = Date.now() - started;
    return {
      ok: false,
      statusCode: 0,
      latencyMs,
      detail: err instanceof Error ? err.message : 'Downloader unreachable',
    };
  }
}

/** Call authenticated POST /api/n8n/resolve safely with strict validation and error classification. */
export async function resolveInstagramSource(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 45_000,
): Promise<DownloaderResolveResult> {
  const cfg = getConfig();
  if (!cfg.downloaderApiKey) {
    throw new AppError('CONFIGURATION_ERROR', 'DOWNLOADER_API_KEY is not configured.', { httpStatus: 500 });
  }

  let res: Response;
  try {
    res = await fetchImpl(`${cfg.downloaderBaseUrl}/api/n8n/resolve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.downloaderApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: sourceUrl }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    } as RequestInit);
  } catch (err) {
    throw new AppError(
      'DOWNLOADER_UNAVAILABLE',
      `Hosted downloader request failed or timed out: ${err instanceof Error ? err.message : String(err)}`,
      { httpStatus: 502 },
    );
  }

  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = (await res.json()) as Record<string, unknown>;
  } catch {
    parsedBody = null;
  }

  if (!res.ok) {
    throw classifyDownloaderHttpFailure(res.status, parsedBody, res.headers);
  }

  return parseDownloaderResolveResponse(parsedBody);
}
