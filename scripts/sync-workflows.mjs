import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConfig } = loadServerModule('lib/config/env.js');
const { assertVerifiedWorkflowExport, inspectWorkflowGraph } = loadServerModule(
  'lib/n8n/workflow-safety.js',
);

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const CREATE_WEBHOOK_CRED = args.has('--create-webhook-cred');

function argVal(prefix) {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length).trim();
  }
  return '';
}

const cfg = getConfig();
if (!cfg.n8nBaseUrl || !cfg.n8nApiKey) {
  console.error('[ERROR] Missing N8N_BASE_URL or N8N_API_KEY in .env.local');
  process.exit(1);
}

const TARGETS = [
  { role: 'W01', id: cfg.workflows.extractId, file: 'n8n/workflows/01-extract-upload.json', activate: true },
  { role: 'W02', id: cfg.workflows.publishId, file: 'n8n/workflows/02-publish-content.json', activate: true },
  { role: 'W03', id: cfg.workflows.scheduleId, file: 'n8n/workflows/03-scheduled-runner.json', activate: false },
  { role: 'W04', id: cfg.workflows.contentId, file: 'n8n/workflows/04-content-management.json', activate: true },
  { role: 'W05', id: cfg.workflows.recoveryId, file: 'n8n/workflows/05-recovery-reconciliation.json', activate: true },
];

async function n8nReq(apiPath, method = 'GET', body) {
  const res = await fetch(`${cfg.n8nBaseUrl}/api/v1/${apiPath}`, {
    method,
    headers: {
      'X-N8N-API-KEY': cfg.n8nApiKey,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`n8n ${method} /api/v1/${apiPath} failed (HTTP ${res.status}): ${text.slice(0, 260)}`);
  }
  return parsed;
}

function classifyHeaderRole(node) {
  const name = String(node.name || '');
  const url = String(node.parameters?.url || '');
  const credName = String(node.credentials?.httpHeaderAuth?.name || '');
  if (
    node.type === 'n8n-nodes-base.webhook' ||
    name.includes('Trigger W02 Publish Webhook') ||
    /webhook|x-dashboard-secret/i.test(credName)
  ) {
    return 'webhook';
  }
  if (name.includes('Downloader') || url.includes('/api/n8n/resolve') || /downloader/i.test(credName)) {
    return 'downloader';
  }
  if (name.includes('Graph') || name.includes('Instagram') || url.includes('graph.facebook.com') || /meta|graph|instagram/i.test(credName)) {
    return 'meta';
  }
  return 'unknown';
}

console.log('=== InstaOps v2.0 n8n Workflow Inspect & Clean Sync ===');
console.log(`Mode: ${APPLY ? 'APPLY (backup + clean PUT replace)' : 'READ-ONLY INSPECT (pass --apply to replace canvases)'}`);

const remoteWfs = new Map();
const discovered = {
  webhook: new Map(),
  downloader: new Map(),
  meta: new Map(),
  supabase: new Map(),
  cloudinary: new Map(),
  sheets: new Map(),
};

for (const t of TARGETS) {
  if (!t.id) {
    console.error(`[ERROR] Missing workflow ID for ${t.role} in .env.local`);
    process.exit(1);
  }
  const remote = await n8nReq(`workflows/${encodeURIComponent(t.id)}`, 'GET');
  remoteWfs.set(t.role, remote);
  const local = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, t.file), 'utf8'));
  const remoteCount = Array.isArray(remote.nodes) ? remote.nodes.length : 0;
  console.log(
    `  ${t.role} (${t.id}): remote=${remoteCount} nodes (active=${Boolean(remote.active)}) -> clean=${local.nodes.length} nodes`,
  );

  for (const node of remote.nodes || []) {
    const creds = node.credentials || {};
    for (const [ctype, val] of Object.entries(creds)) {
      const cid = String(val?.id || '').trim();
      const cname = String(val?.name || '').trim();
      if (!cid || cid.startsWith('CONFIGURE_')) continue;
      if (ctype === 'httpCustomAuth') {
        discovered.supabase.set(cid, { id: cid, name: cname || 'Custom Auth account' });
      } else if (ctype === 'httpBasicAuth') {
        discovered.cloudinary.set(cid, { id: cid, name: cname || 'Unnamed credential' });
      } else if (ctype === 'googleSheetsOAuth2Api') {
        discovered.sheets.set(cid, { id: cid, name: cname || 'Google Sheets account' });
      } else if (ctype === 'httpHeaderAuth') {
        const hRole = classifyHeaderRole(node);
        if (hRole !== 'unknown') {
          discovered[hRole].set(cid, { id: cid, name: cname });
        }
      }
    }
  }
}

console.log('\nDiscovered Live Credential Bindings on Remote Nodes:');
for (const [role, map] of Object.entries(discovered)) {
  const list = Array.from(map.values()).map((c) => `${c.id} ("${c.name}")`);
  console.log(`  ${role.padEnd(11)}: ${list.length > 0 ? list.join(', ') : '(NONE BOUND — configure in n8n UI or override via CLI)'}`);
}

let webhookCred = argVal('--webhook-cred=')
  ? { id: argVal('--webhook-cred='), name: 'InstaOps Webhook Secret (x-dashboard-secret)' }
  : Array.from(discovered.webhook.values())[0] || null;
const downloaderCred = argVal('--downloader-cred=')
  ? { id: argVal('--downloader-cred='), name: 'InstaOps Downloader Bearer Auth' }
  : Array.from(discovered.downloader.values())[0] || null;
const metaCred = argVal('--meta-cred=')
  ? { id: argVal('--meta-cred='), name: 'Meta Graph API Token Auth' }
  : Array.from(discovered.meta.values())[0] || null;
const supabaseCred = Array.from(discovered.supabase.values())[0] || { id: '7QtiSqfp0ZkTj6TQ', name: 'Custom Auth account' };
const cloudinaryCred = Array.from(discovered.cloudinary.values())[0] || { id: 'J5X8exo033nX3vMT', name: 'Unnamed credential' };
const sheetsCred = Array.from(discovered.sheets.values())[0] || { id: 'PZ0clxfFCt2bQvpU', name: 'Google Sheets account' };

if (!APPLY) {
  console.log('\nInspect complete. No remote workflows were modified.');
  process.exit(0);
}

if (CREATE_WEBHOOK_CRED) {
  if (!cfg.n8nWebhookSecret) {
    console.error('[ERROR] N8N_WEBHOOK_SECRET missing in .env.local');
    process.exit(1);
  }
  const created = await n8nReq('credentials', 'POST', {
    name: `InstaOps Webhook Secret (${new Date().toISOString().slice(0, 10)})`,
    type: 'httpHeaderAuth',
    data: {
      name: 'x-dashboard-secret',
      value: cfg.n8nWebhookSecret,
    },
  });
  webhookCred = { id: String(created.id), name: String(created.name) };
  console.log(`\n[CREATED] New httpHeaderAuth credential for x-dashboard-secret: ${webhookCred.id} ("${webhookCred.name}")`);
}

if (!webhookCred || !downloaderCred || !metaCred) {
  console.error('\n[ERROR] Cannot cleanly replace workflows while required separated Header Auth credentials are missing.');
  console.error('Found:', { webhookCred, downloaderCred, metaCred });
  console.error('Pass --webhook-cred=<id> --downloader-cred=<id> --meta-cred=<id> (or --create-webhook-cred for webhook secret).');
  process.exit(1);
}

const distinctHeaderIds = new Set([webhookCred.id, downloaderCred.id, metaCred.id]);
if (distinctHeaderIds.size < 3) {
  console.error('\n[ERROR] Security violation: Webhook, Downloader, and Meta Graph credentials MUST be 3 separate n8n credentials.');
  process.exit(1);
}

// 1. Write full timestamped backup of all 5 remote workflows before touching anything
const backupDir = path.join(
  ROOT_DIR,
  '.backups',
  'n8n',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
fs.mkdirSync(backupDir, { recursive: true });
for (const t of TARGETS) {
  fs.writeFileSync(
    path.join(backupDir, `${t.role}-${t.id}.json`),
    JSON.stringify(remoteWfs.get(t.role), null, 2),
    'utf8',
  );
}
console.log(`\n[BACKUP] Saved pre-replacement snapshots to ${path.relative(ROOT_DIR, backupDir)}`);

// 2. Prepare and verify every cleaned workflow payload BEFORE any PUT call
const prepared = [];
for (const t of TARGETS) {
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, t.file), 'utf8'));
  for (const node of wf.nodes || []) {
    if (!node.credentials) continue;
    for (const [ctype, cval] of Object.entries(node.credentials)) {
      const cid = String(cval?.id || '');
      if (ctype === 'httpCustomAuth') {
        node.credentials[ctype] = { id: supabaseCred.id, name: supabaseCred.name };
      } else if (ctype === 'httpBasicAuth') {
        node.credentials[ctype] = { id: cloudinaryCred.id, name: cloudinaryCred.name };
      } else if (ctype === 'googleSheetsOAuth2Api') {
        node.credentials[ctype] = { id: sheetsCred.id, name: sheetsCred.name };
      } else if (ctype === 'httpHeaderAuth') {
        if (cid === 'CONFIGURE_WEBHOOK') {
          node.credentials[ctype] = { id: webhookCred.id, name: webhookCred.name };
        } else if (cid === 'CONFIGURE_DOWNLOADER') {
          node.credentials[ctype] = { id: downloaderCred.id, name: downloaderCred.name };
        } else if (cid === 'CONFIGURE_META') {
          node.credentials[ctype] = { id: metaCred.id, name: metaCred.name };
        }
      }
    }
  }
  assertVerifiedWorkflowExport(t.role, wf);
  const insp = inspectWorkflowGraph(wf);
  if (insp.unboundPlaceholders.length > 0 || insp.triggerCount !== 1 || insp.unreachableNodeCount > 0) {
    throw new Error(`${t.role} failed pre-upload integrity check: ${JSON.stringify(insp)}`);
  }
  prepared.push({ ...t, wf });
}

// 3. Deactivate -> clean PUT replacement -> activate (W03 stays inactive)
for (const item of prepared) {
  const encId = encodeURIComponent(item.id);
  try {
    await n8nReq(`workflows/${encId}/deactivate`, 'POST');
  } catch {
    // ignore if already inactive
  }
  const putBody = {
    name: item.wf.name,
    nodes: item.wf.nodes,
    connections: item.wf.connections,
    settings: item.wf.settings || { executionOrder: 'v1' },
  };
  await n8nReq(`workflows/${encId}`, 'PUT', putBody);
  if (item.activate) {
    await n8nReq(`workflows/${encId}/activate`, 'POST');
  }
  const after = await n8nReq(`workflows/${encId}`, 'GET');
  console.log(
    `[REPLACED] ${item.role} (${item.id}): nodes=${Array.isArray(after.nodes) ? after.nodes.length : '?'} active=${Boolean(after.active)}`,
  );
}

console.log('\nDone! Now run "npm run check:connection" to verify W05 webhook auth and all live services.');
