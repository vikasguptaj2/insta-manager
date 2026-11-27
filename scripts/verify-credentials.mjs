import { loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConfig, validateConfig } = loadServerModule('lib/config/env.js');
const { redactSensitive } = loadServerModule('lib/errors/codes.js');
const { checkDownloaderHealth } = loadServerModule('lib/downloader/client.js');
const { SupabaseRepository } = loadServerModule('lib/supabase/server.js');

const cfg = getConfig();
const validation = validateConfig(cfg);

console.log('=== InstaOps v2.0 Credential & Endpoint Hygiene Audit ===');
console.log(`Demo Mode: ${cfg.demoMode}`);
console.log(`Config Errors: ${validation.errors.length ? validation.errors.join(' | ') : 'None'}`);
console.log(`Warnings: ${validation.warnings.length ? validation.warnings.join(' | ') : 'None'}`);

if (cfg.supabaseUrl && cfg.supabaseServiceRoleKey) {
  const health = await new SupabaseRepository().checkHealth();
  console.log(`Supabase Primary (${cfg.supabaseUrl}): ${health.ok ? 'OK' : 'FAIL'} - ${health.detail}`);
  if (!health.ok) process.exitCode = 1;
} else {
  console.log('Supabase Primary probe skipped: SUPABASE_SERVICE_ROLE_KEY not configured.');
}

const dl = await checkDownloaderHealth(fetch, 8_000).catch((e) => ({
  ok: false,
  detail: redactSensitive(e instanceof Error ? e.message : String(e)),
}));
console.log(`Downloader Health (${cfg.downloaderBaseUrl}): ${dl.ok ? 'OK' : 'FAIL'} - ${dl.detail}`);

if (cfg.n8nApiKey && cfg.n8nBaseUrl) {
  try {
    const res = await fetch(`${cfg.n8nBaseUrl}/api/v1/workflows?limit=25`, {
      headers: { 'X-N8N-API-KEY': cfg.n8nApiKey },
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`n8n REST API (${cfg.n8nBaseUrl}): HTTP ${res.status}`);
    if (!res.ok) process.exitCode = 1;
  } catch (e) {
    console.error(`n8n REST API unreachable: ${redactSensitive(e instanceof Error ? e.message : String(e))}`);
    process.exitCode = 1;
  }
} else {
  console.log('n8n REST API check skipped: N8N_API_KEY not configured.');
}
