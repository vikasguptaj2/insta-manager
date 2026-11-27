import { ROOT_DIR, loadLocalEnv, loadServerModule } from './_env.mjs';

const envStatus = loadLocalEnv('.env.local');
const { getConfig, validateConfig } = loadServerModule('lib/config/env.js');
const { scanDirectoryForSecrets } = loadServerModule('lib/security/secret-scan.js');

const cfg = getConfig();
const validation = validateConfig(cfg);
const secretFindings = await scanDirectoryForSecrets(ROOT_DIR);

console.log('=== InstaOps v2.0 Configuration & Supabase Security Check ===');
console.log(`.env.local loaded: ${envStatus.loaded ? 'yes' : 'no (using process.env defaults)'}`);
console.log(`DEMO_MODE: ${cfg.demoMode}`);
console.log(`Supabase URL: ${cfg.supabaseUrl}`);
console.log(`Supabase Anon Key present: ${Boolean(cfg.supabaseAnonKey)}`);
console.log(`Supabase Service Role Key present (server-only): ${Boolean(cfg.supabaseServiceRoleKey)}`);
console.log(`n8n Base URL: ${cfg.n8nBaseUrl}`);
console.log(`Downloader URL: ${cfg.downloaderBaseUrl}`);
console.log(`IG Account: ${cfg.instagramAccountLabel} (${cfg.instagramUserId})`);
console.log(`Cloud Name: ${cfg.cloudinaryCloudName}`);
console.log(`Lock Provider: ${cfg.atomicLockProvider}`);
console.log(`Google Sheets Reporting Sync Enabled: ${cfg.sheetsSyncEnabled}`);
console.log(`Config valid: ${validation.valid}`);

if (validation.errors.length > 0) {
  console.log('\nConfiguration errors:');
  for (const err of validation.errors) console.log(`  - ${err}`);
}

if (validation.warnings.length > 0) {
  console.log('\nWarnings:');
  for (const w of validation.warnings) console.log(`  - ${w}`);
}

console.log(`\nRepository secret scan findings: ${secretFindings.length}`);
for (const f of secretFindings) {
  console.log(`  [!] ${f.file}:${f.line} (${f.pattern})`);
}

if (!validation.valid || secretFindings.length > 0) {
  process.exitCode = 1;
}
