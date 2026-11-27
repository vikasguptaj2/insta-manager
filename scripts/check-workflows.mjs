import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadServerModule } from './_env.mjs';

const { assertVerifiedWorkflowExport } = loadServerModule('lib/n8n/workflow-safety.js');

const WORKFLOW_MAP = [
  ['W01', 'n8n/workflows/01-extract-upload.json'],
  ['W02', 'n8n/workflows/02-publish-content.json'],
  ['W03', 'n8n/workflows/03-scheduled-runner.json'],
  ['W04', 'n8n/workflows/04-content-management.json'],
  ['W05', 'n8n/workflows/05-recovery-reconciliation.json'],
];

console.log('=== InstaOps v2.0 n8n Workflow Safety Verification ===');
for (const [role, rel] of WORKFLOW_MAP) {
  const full = path.join(ROOT_DIR, rel);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  assertVerifiedWorkflowExport(role, json);
  console.log(`[PASS] ${role}: ${json.name} (${json.nodes.length} nodes, active=${json.active})`);
}
