import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getConfig } from '../../../lib/config/env';
import { getReadinessDiagnostics } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const cfg = getConfig();
    const url = new URL(req.url, 'http://127.0.0.1:3000');
    const forceRefresh =
      url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
    const { readiness, connections, validation, requestId, fromCache, checkedAt } =
      await getReadinessDiagnostics(fetch, { forceRefresh });
    return jsonOk({
      ok: validation.valid,
      appName: cfg.appName,
      demoMode: cfg.demoMode,
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      summary: validation.summary,
      readiness,
      connections,
      requestId,
      fromCache,
      checkedAt,
      now: new Date().toISOString(),
    });
  });
}
