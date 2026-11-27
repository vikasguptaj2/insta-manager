import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { redactSensitive } from '../../lib/errors/codes';
import {
  assertLocalRequest,
  clearRateLimitBucketsForTest,
  enforceRateLimit,
  sanitizeSpreadsheetText,
  validateSafeId,
} from '../../lib/security/http-guard';
import { scanDirectoryForSecrets } from '../../lib/security/secret-scan';
import {
  assertConfiguredCloudinaryUrl,
  assertSafeExternalUrl,
  isPrivateIp,
} from '../../lib/security/ssrf';

describe('Security, SSRF, rate-limit, and secret hygiene', () => {
  beforeEach(() => {
    clearRateLimitBucketsForTest();
    process.env.PUBLIC_ACCESS_ENABLED = 'false';
    process.env.CLOUDINARY_CLOUD_NAME = 'djkkknb9k';
  });

  it('enforces localhost origin guard and rate limiting', () => {
    const okReq = new Request('http://127.0.0.1:3000/api/overview', {
      headers: { host: '127.0.0.1:3000' },
    });
    assert.doesNotThrow(() => assertLocalRequest(okReq));

    const badReq = new Request('https://evil.example/api/overview', {
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    assert.throws(() => assertLocalRequest(badReq), /Untrusted Host header/i);

    for (let i = 0; i < 3; i++) enforceRateLimit('test:bucket', 3, 60_000, 1000);
    assert.throws(
      () => enforceRateLimit('test:bucket', 3, 60_000, 1000),
      /Too many sensitive requests|Rate limit exceeded/i,
    );
  });

  it('blocks private IPv4/IPv6 ranges and non-allowlisted hosts against SSRF', async () => {
    assert.equal(isPrivateIp('127.0.0.1'), true);
    assert.equal(isPrivateIp('169.254.169.254'), true);
    assert.equal(isPrivateIp('10.0.0.5'), true);
    assert.equal(isPrivateIp('192.168.1.20'), true);
    assert.equal(isPrivateIp('157.240.1.1'), false);

    await assert.rejects(
      assertSafeExternalUrl('http://169.254.169.254/latest/meta-data'),
      /Only HTTPS remote URLs/i,
    );
    await assert.rejects(
      assertSafeExternalUrl('https://127.0.0.1/secret.mp4'),
      /Direct IP literal URLs/i,
    );
    assert.throws(
      () => assertConfiguredCloudinaryUrl('https://res.cloudinary.com/othercloud/video/upload/x.mp4'),
      /different cloud name|configured Cloudinary cloud/i,
    );
    assert.doesNotThrow(() =>
      assertConfiguredCloudinaryUrl('https://res.cloudinary.com/djkkknb9k/video/upload/v1/x.mp4'),
    );
  });

  it('sanitizes formula injections, IDs, and masks credentials in error text', () => {
    assert.equal(sanitizeSpreadsheetText('=cmd|"/c calc"!A0'), "'=cmd|\"/c calc\"!A0");
    assert.equal(validateSafeId('IG-2026_01', 'post'), 'IG-2026_01');
    assert.throws(() => validateSafeId('../etc/passwd', 'post'));

    const syntheticSecret = ['Bearer', 'SyntheticTestToken_0123456789'].join(' ');
    const masked = String(redactSensitive(syntheticSecret));
    assert.doesNotMatch(masked, /SyntheticTestToken/);
    assert.match(masked, /redacted/i);
  });

  it('contains zero committed secrets in the InstaOps v2.0 codebase', async () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const findings = await scanDirectoryForSecrets(repoRoot);
    assert.deepEqual(findings, []);
  });
});
