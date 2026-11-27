import { handleApiRequest, jsonOk } from '../../../lib/api-handler';
import { getConfig, validateConfig } from '../../../lib/config/env';
import { enforceRateLimit, readJsonBody } from '../../../lib/security/http-guard';
import { getOverviewData, updateRuntimeSettings } from '../../../lib/service';

export async function GET(req: Request) {
  return handleApiRequest(req, async () => {
    const cfg = getConfig();
    const validation = validateConfig(cfg);
    const ov = await getOverviewData();
    return jsonOk({
      ok: true,
      settings: {
        appName: cfg.appName,
        timezone: cfg.timezone,
        demoMode: cfg.demoMode,
        supabaseUrl: cfg.supabaseUrl,
        n8nBaseUrl: cfg.n8nBaseUrl,
        downloaderBaseUrl: cfg.downloaderBaseUrl,
        accountLabel: cfg.instagramAccountLabel,
        igUserId: cfg.instagramUserId,
        cloudName: cfg.cloudinaryCloudName,
        sheetsSyncEnabled: cfg.sheetsSyncEnabled,
        sheetId: cfg.googleSheetId,
        sheetGid: cfg.googleSheetGid,
        atomicLockProvider: cfg.atomicLockProvider,
        flags: ov.flags,
      },
      readiness: ov.readiness,
      validation,
    });
  });
}

export async function PATCH(req: Request) {
  return handleApiRequest(req, async () => {
    enforceRateLimit('settings:patch', 6, 60_000);
    const body = await readJsonBody(req);
    const schedulingEnabled =
      typeof body.schedulingEnabled === 'boolean' ? body.schedulingEnabled : undefined;
    const livePublishEnabled =
      typeof body.livePublishEnabled === 'boolean' ? body.livePublishEnabled : undefined;
    const liveDeleteEnabled =
      typeof body.liveDeleteEnabled === 'boolean' ? body.liveDeleteEnabled : undefined;
    const reason = typeof body.reason === 'string' ? body.reason.trim() : undefined;
    const result = await updateRuntimeSettings({
      schedulingEnabled,
      livePublishEnabled,
      liveDeleteEnabled,
      reason,
      updatedBy: 'dashboard_settings_api',
    });
    return jsonOk({ ok: true, settings: result });
  });
}
