import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConfig } = loadServerModule('lib/config/env.js');

const cfg = getConfig();
const outDir = path.join(ROOT_DIR, '.backups');
fs.mkdirSync(outDir, { recursive: true });

const safeSnapshot = {
  exportedAt: new Date().toISOString(),
  appName: cfg.appName,
  timezone: cfg.timezone,
  demoMode: cfg.demoMode,
  supabaseUrl: cfg.supabaseUrl,
  sheetsSyncEnabled: cfg.sheetsSyncEnabled,
  n8nBaseUrl: cfg.n8nBaseUrl,
  downloaderBaseUrl: cfg.downloaderBaseUrl,
  instagramAccountLabel: cfg.instagramAccountLabel,
  instagramUserId: cfg.instagramUserId,
  instagramGraphVersion: cfg.instagramGraphVersion,
  googleSheetId: cfg.googleSheetId,
  googleSheetGid: cfg.googleSheetGid,
  sheetsTabs: cfg.sheetsTabs,
  cloudinaryCloudName: cfg.cloudinaryCloudName,
  atomicLockProvider: cfg.atomicLockProvider,
  workflows: {
    extractId: cfg.workflows.extractId,
    publishId: cfg.workflows.publishId,
    scheduleId: cfg.workflows.scheduleId,
    contentId: cfg.workflows.contentId,
    recoveryId: cfg.workflows.recoveryId,
    extractPath: cfg.workflows.extractPath,
    publishPath: cfg.workflows.publishPath,
    contentPath: cfg.workflows.contentPath,
    recoveryPath: cfg.workflows.recoveryPath,
  },
  flags: cfg.flags,
  secretsIncluded: false,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = path.join(outDir, `config-backup-${stamp}.json`);
fs.writeFileSync(outFile, `${JSON.stringify(safeSnapshot, null, 2)}\n`, 'utf8');
console.log(`Redacted non-secret configuration backup written to ${outFile}`);
