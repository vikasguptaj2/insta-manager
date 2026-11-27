import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadServerModule } from './_env.mjs';

const { verifyWorkflowExport } = loadServerModule('lib/n8n/workflow-safety.js');

const FILES = [
  ['W01', 'n8n/workflows/01-extract-upload.json'],
  ['W02', 'n8n/workflows/02-publish-content.json'],
  ['W03', 'n8n/workflows/03-scheduled-runner.json'],
  ['W04', 'n8n/workflows/04-content-management.json'],
  ['W05', 'n8n/workflows/05-recovery-reconciliation.json'],
];

let hasErrors = false;
for (const [role, rel] of FILES) {
  const full = path.join(ROOT_DIR, rel);
  const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  parsed.active = false;
  fs.writeFileSync(full, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  const res = verifyWorkflowExport(role, parsed);
  if (!res.valid) {
    hasErrors = true;
    console.error(`[FAIL] ${role} (${rel}):`, res.errors);
  } else {
    console.log(`[OK] ${role} (${rel}) formatted & verified.`);
  }
}

if (hasErrors) process.exitCode = 1;
