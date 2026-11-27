import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConfig } = loadServerModule('lib/config/env.js');
const { getLockStore } = loadServerModule('lib/jobs/lock-store.js');
const { SupabaseRepository } = loadServerModule('lib/supabase/server.js');
const {
  MAIN_SHEET_COLUMNS,
  MEDIA_ASSETS_COLUMNS,
  EXECUTION_LOGS_COLUMNS,
  ACCOUNTS_COLUMNS,
} = loadServerModule('lib/domain/schema.js');

const schemaPath = path.join(ROOT_DIR, 'n8n', 'migrations', 'google-sheets-schema.json');
const doc = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

function assertSameArray(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch between lib/domain/schema.ts and google-sheets-schema.json`);
  }
  console.log(`[PASS] Sheet Schema ${label}: ${actual.length} columns verified`);
}

console.log('=== InstaOps v2.0 Supabase & Reporting Schema Verification ===');
assertSameArray('Posts', [...MAIN_SHEET_COLUMNS], doc.tabs.Posts.columns);
assertSameArray('MediaAssets', [...MEDIA_ASSETS_COLUMNS], doc.tabs.MediaAssets.columns);
assertSameArray('ExecutionLogs', [...EXECUTION_LOGS_COLUMNS], doc.tabs.ExecutionLogs.columns);
assertSameArray('Accounts', [...ACCOUNTS_COLUMNS], doc.tabs.Accounts.columns);

const installFresh = path.join(ROOT_DIR, 'supabase', 'INSTALL_FRESH.sql');
if (!fs.existsSync(installFresh)) {
  throw new Error('Missing supabase/INSTALL_FRESH.sql');
}
console.log('[PASS] supabase/INSTALL_FRESH.sql present');

const cfg = getConfig();
if (cfg.supabaseUrl && cfg.supabaseServiceRoleKey) {
  const repo = new SupabaseRepository();
  const health = await repo.checkHealth();
  console.log(`Supabase live probe: ${health.ok ? 'CONNECTED' : 'FAILED'} - ${health.detail}`);
  if (!health.ok) process.exitCode = 1;
} else if (cfg.databaseUrl && cfg.atomicLockProvider === 'postgres') {
  const store = getLockStore();
  await store.ensureSchema();
  console.log('[PASS] Direct PostgreSQL lock tables verified');
  await store.close();
} else {
  console.log('[INFO] Live Supabase probe skipped (configure SUPABASE_SERVICE_ROLE_KEY in .env.local after running INSTALL_FRESH.sql).');
}
