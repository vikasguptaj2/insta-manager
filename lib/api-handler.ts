import { NextResponse } from 'next/server';
import { normalizeError } from './errors/codes';
import { assertLocalRequest, SECURITY_HEADERS } from './security/http-guard';

export function jsonOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: SECURITY_HEADERS });
}

export function jsonError(err: unknown): NextResponse {
  const appErr = normalizeError(err);
  return NextResponse.json(
    { ok: false, error: appErr.toPayload() },
    { status: appErr.httpStatus, headers: SECURITY_HEADERS },
  );
}

export async function handleApiRequest(
  req: Request,
  handler: () => Promise<NextResponse>,
  opts?: { requireJson?: boolean },
): Promise<NextResponse> {
  try {
    assertLocalRequest(req, opts);
    return await handler();
  } catch (err) {
    return jsonError(err);
  }
}
