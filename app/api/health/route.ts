import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getConfig } from '../../../lib/config/env';
import { getReadinessDiagnostics } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const cfg = getConfig();
    const { readiness, connections, validation } = await getReadinessDiagnostics();
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
      now: new Date().toISOString(),
    });
  });
}
