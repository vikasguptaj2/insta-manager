import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getConfig, validateConfig } from '../../../lib/config/env';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const cfg = getConfig();
    const report = validateConfig(cfg);
    return jsonOk({
      ok: report.valid,
      appName: cfg.appName,
      demoMode: cfg.demoMode,
      valid: report.valid,
      errors: report.errors,
      warnings: report.warnings,
      summary: report.summary,
      now: new Date().toISOString(),
    });
  });
}
