import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError } from '../errors/codes';
import { getConfig } from '../config/env';

const ALLOWED_MEDIA_HOST_SUFFIXES = [
  '.cdninstagram.com',
  '.fbcdn.net',
  'res.cloudinary.com',
];

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local & AWS IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    const mappedV4 = lower.slice(7);
    if (net.isIPv4(mappedV4)) return isPrivateOrReservedIpv4(mappedV4);
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true; // link-local
  }
  if (lower.startsWith('ff')) return true; // multicast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateOrReservedIpv4(ip);
  if (version === 6) return isPrivateOrReservedIpv6(ip);
  return true;
}

export function isAllowedMediaHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return ALLOWED_MEDIA_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix,
  );
}

export interface SsrfOptions {
  allowedHosts?: string[];
  allowHttpLocalhost?: boolean;
  skipDnsLookup?: boolean;
}

/** Strictly verify HTTPS external URLs against allowlists and DNS/IP SSRF rules. */
export async function assertSafeExternalUrl(rawUrl: string, opts?: SsrfOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AppError('INVALID_SOURCE_URL', 'Malformed URL rejected.', { httpStatus: 422 });
  }

  const host = url.hostname.toLowerCase();
  const isLocalHost = host === 'localhost' || host === '127.0.0.1';
  if (url.protocol !== 'https:' && !(opts?.allowHttpLocalhost && url.protocol === 'http:' && isLocalHost)) {
    throw new AppError('INVALID_SOURCE_URL', 'Only HTTPS remote URLs are allowed.', { httpStatus: 422 });
  }

  if (url.username || url.password) {
    throw new AppError('INVALID_SOURCE_URL', 'URLs containing embedded credentials are forbidden.', {
      httpStatus: 422,
    });
  }

  if (net.isIP(host) && !(opts?.allowHttpLocalhost && isLocalHost)) {
    throw new AppError('INVALID_SOURCE_URL', 'Direct IP literal URLs are not allowed.', {
      httpStatus: 422,
    });
  }

  if (opts?.allowedHosts?.length) {
    const allowed = opts.allowedHosts.map((h) => h.toLowerCase());
    if (!allowed.includes(host)) {
      throw new AppError('UNAUTHORIZED_CONTENT', `Host ${host} is outside configured allowlist.`, {
        httpStatus: 403,
      });
    }
  } else if (!isAllowedMediaHost(host)) {
    throw new AppError('UNAUTHORIZED_CONTENT', `Media host ${host} is not an allowlisted Instagram/Cloudinary host.`, {
      httpStatus: 403,
    });
  }

  if (!opts?.skipDnsLookup && !isLocalHost) {
    let records: Array<{ address: string }>;
    try {
      records = await dns.lookup(host, { all: true });
    } catch {
      throw new AppError('DOWNLOADER_UNAVAILABLE', `Failed to resolve DNS for ${host}.`, {
        httpStatus: 502,
      });
    }
    if (!records.length || records.some((r) => isPrivateIp(r.address))) {
      throw new AppError('UNAUTHORIZED_CONTENT', `Resolved private/reserved address rejected for ${host}.`, {
        httpStatus: 403,
      });
    }
  }

  return url;
}

/** Validate Cloudinary delivery URL belongs strictly to configured cloud name. */
export function assertConfiguredCloudinaryUrl(rawUrl: string): URL {
  const cfg = getConfig();
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new AppError('INVALID_MEDIA_TYPE', 'Invalid Cloudinary URL.', { httpStatus: 422 });
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'res.cloudinary.com') {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Unexpected media delivery host.', { httpStatus: 403 });
  }
  const cloudPrefix = `/${cfg.cloudinaryCloudName}/`;
  if (!url.pathname.startsWith(cloudPrefix)) {
    throw new AppError('UNAUTHORIZED_CONTENT', 'Cloudinary URL belongs to a different cloud name.', {
      httpStatus: 403,
    });
  }
  return url;
}
