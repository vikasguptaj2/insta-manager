import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConfig } = loadServerModule('lib/config/env.js');
const { n8nWebhookRequest } = loadServerModule('lib/n8n/client.js');

const apply = process.argv.includes('--apply');
const schemaPath = path.join(ROOT_DIR, 'n8n', 'migrations', 'google-sheets-schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const cfg = getConfig();

console.log('=== InstaOps v2.0 Google Sheets Schema Migration ===');
console.log(`Target Spreadsheet: ${cfg.googleSheetId || schema.spreadsheetId}`);
console.log(`Mode: ${apply ? 'APPLY CHECK' : 'DRY RUN (default safe mode; pass --apply after importing W04)'}`);

for (const [tabName, def] of Object.entries(schema.tabs)) {
  const cols = def.columns || [];
  console.log(`\nTab "${tabName}": ${cols.length} expected columns`);
  console.log(`  Header row: ${cols.join(' | ')}`);
}

if (!apply) {
  console.log('\nDry-run complete. Create/extend tabs matching the headers above or import W04 and run:');
  console.log('  node scripts/migrate-sheets.mjs --apply');
  process.exit(0);
}

if (cfg.demoMode || !cfg.n8nWebhookSecret) {
  console.error('\n[BLOCKED] --apply requires DEMO_MODE=false and valid N8N_WEBHOOK_SECRET.');
  process.exitCode = 1;
} else {
  const res = await n8nWebhookRequest(cfg.workflows.contentPath, { action: 'LIST_POSTS', request_id: crypto.randomUUID() }, 30_000);
  const existingKeys = res.rows && res.rows[0] ? Object.keys(res.rows[0]) : [];
  const expectedPosts = schema.tabs.Posts.columns;
  const missingCols = expectedPosts.filter((c) => !existingKeys.includes(c));
  console.log(`\nLive Posts row sample keys: ${existingKeys.length}`);
  console.log(`Missing v2 columns in Posts header: ${missingCols.length ? missingCols.join(', ') : 'None (aligned)'}`);
}
