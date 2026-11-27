import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadLocalEnv, loadServerModule } from './_env.mjs';

loadLocalEnv('.env.local');
const { getConfig } = loadServerModule('lib/config/env.js');
const { assertVerifiedWorkflowExport, inspectWorkflowGraph } = loadServerModule(
  'lib/n8n/workflow-safety.js',
);

const RAW_ARGS = process.argv.slice(2);
const APPLY = RAW_ARGS.includes('--apply');
const ROLLBACK_DIR = argVal('--rollback=');

const TARGETS = [
  { role: 'W01', file: 'n8n/workflows/01-extract-upload.json', expectedNodes: 39, activate: true },
  { role: 'W02', file: 'n8n/workflows/02-publish-content.json', expectedNodes: 93, activate: true },
  { role: 'W03', file: 'n8n/workflows/03-scheduled-runner.json', expectedNodes: 17, activate: false },
  { role: 'W04', file: 'n8n/workflows/04-content-management.json', expectedNodes: 46, activate: true },
  { role: 'W05', file: 'n8n/workflows/05-recovery-reconciliation.json', expectedNodes: 37, activate: true },
];

const MANAGED_WEBHOOK_PATHS = new Set([
  'instaops-extract-v1',
  'instaops-publish-v1',
  'instaops-content-v1',
  'instaops-recovery-v1',
]);

const ALLOWED_PUT_SETTINGS_KEYS = [
  'executionOrder',
  'errorWorkflow',
  'timezone',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'saveManualExecutions',
  'saveExecutionProgress',
  'executionTimeout',
  'callerPolicy',
];

const ALLOWED_FLAG_PREFIXES = [
  '--webhook-cred=',
  '--downloader-cred=',
  '--meta-cred=',
  '--supabase-cred=',
  '--cloudinary-cred=',
  '--sheets-cred=',
  '--rollback=',
];

function validateCliArgs() {
  for (const arg of RAW_ARGS) {
    if (arg === '--apply') continue;
    if (ALLOWED_FLAG_PREFIXES.some((prefix) => arg.startsWith(prefix))) continue;
    failAndExit(
      `Unknown argument "${arg}". Supported flags: --apply, --rollback=<dir>, ` +
        '--webhook-cred=<id>, --downloader-cred=<id>, --meta-cred=<id>, ' +
        '--supabase-cred=<id>, --cloudinary-cred=<id>, --sheets-cred=<id>.',
    );
  }
}

function argVal(prefix) {
  for (const arg of RAW_ARGS) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return '';
}

function toPosixRel(absPath) {
  return path.relative(ROOT_DIR, absPath).replace(/\\/g, '/');
}

function failAndExit(message) {
  console.error(`\n[ERROR] ${message}`);
  process.exit(1);
}

function getTargetWorkflowId(cfg, role) {
  const map = {
    W01: cfg.workflows.extractId,
    W02: cfg.workflows.publishId,
    W03: cfg.workflows.scheduleId,
    W04: cfg.workflows.contentId,
    W05: cfg.workflows.recoveryId,
  };
  return String(map[role] || '').trim();
}

function pickPutSettings(rawSettings) {
  const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const out = {};
  for (const key of ALLOWED_PUT_SETTINGS_KEYS) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  if (!out.executionOrder) {
    out.executionOrder = 'v1';
  }
  return out;
}

function buildPutBody(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes,
    connections: wf.connections,
    settings: pickPutSettings(wf.settings),
  };
}

function createN8nClient(baseUrl, apiKey) {
  return async function n8nReq(apiPath, method = 'GET', body, options = {}) {
    const res = await fetch(`${baseUrl}/api/v1/${apiPath}`, {
      method,
      headers: {
        'X-N8N-API-KEY': apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      if (options.allowStatuses && options.allowStatuses.includes(res.status)) {
        return { __unsupportedStatus: res.status, raw: parsed };
      }
      throw new Error(
        `n8n ${method} /api/v1/${apiPath} failed (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return parsed;
  };
}

function classifyHeaderRole(node) {
  const name = String(node.name || '');
  const url = String(node.parameters?.url || '');
  const cid = String(node.credentials?.httpHeaderAuth?.id || '').trim();
  if (
    cid === 'CONFIGURE_WEBHOOK' ||
    node.type === 'n8n-nodes-base.webhook' ||
    url.includes('/webhook/instaops-') ||
    name.includes('Trigger W02 Publish Webhook')
  ) {
    return 'webhook';
  }
  if (
    cid === 'CONFIGURE_DOWNLOADER' ||
    url.includes('/api/n8n/resolve') ||
    url.includes('dl_url') ||
    name.includes('Downloader')
  ) {
    return 'downloader';
  }
  if (
    cid === 'CONFIGURE_META' ||
    url.includes('graph.facebook.com') ||
    url.includes('graph_url') ||
    url.includes('poll_url') ||
    name.includes('Graph') ||
    name.includes('Instagram')
  ) {
    return 'meta';
  }
  return 'unknown';
}

function collectDiscoveredCredentials(remoteWfs) {
  const discovered = {
    webhook: new Map(),
    downloader: new Map(),
    meta: new Map(),
    supabase: new Map(),
    cloudinary: new Map(),
    sheets: new Map(),
  };

  for (const remote of remoteWfs.values()) {
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
            discovered[hRole].set(cid, { id: cid, name: cname || 'httpHeaderAuth' });
          }
        }
      }
    }
  }
  return discovered;
}

function findSharedHeaderCredentialWarnings(discovered) {
  const roleById = new Map();
  for (const role of ['webhook', 'downloader', 'meta']) {
    for (const cred of discovered[role].values()) {
      const arr = roleById.get(cred.id) || [];
      arr.push(role);
      roleById.set(cred.id, arr);
    }
  }
  const shared = [];
  for (const [id, roles] of roleById.entries()) {
    if (roles.length > 1) {
      shared.push({ id, roles });
    }
  }
  return shared;
}

function resolveNonHeaderCredential(role, flagName, expectedType, defaultLabel, discoveredMap) {
  const explicitId = argVal(flagName);
  if (explicitId) {
    if (explicitId.startsWith('CONFIGURE_')) {
      failAndExit(`${flagName} cannot be a CONFIGURE_* placeholder.`);
    }
    const known = discoveredMap.get(explicitId);
    return {
      id: explicitId,
      name: known?.name || defaultLabel,
      type: expectedType,
    };
  }
  if (discoveredMap.size !== 1) {
    const foundList = Array.from(discoveredMap.values())
      .map((c) => `${c.id} ("${c.name}")`)
      .join(', ');
    failAndExit(
      `Cannot determine unambiguous ${role} (${expectedType}) credential automatically ` +
        `(found ${discoveredMap.size}: ${foundList || 'none'}). Pass ${flagName}<id> explicitly.`,
    );
  }
  const only = Array.from(discoveredMap.values())[0];
  return { id: only.id, name: only.name || defaultLabel, type: expectedType };
}

function resolveExplicitHeaderCredential(role, flagName, defaultLabel) {
  const explicitId = argVal(flagName);
  if (!explicitId) {
    return null;
  }
  if (explicitId.startsWith('CONFIGURE_')) {
    failAndExit(`${flagName} cannot be a CONFIGURE_* placeholder (received "${explicitId}").`);
  }
  return { id: explicitId, name: defaultLabel, type: 'httpHeaderAuth', role };
}

async function validateCredentialsWithN8n(n8nReq, creds) {
  const listed = await n8nReq('credentials?limit=250', 'GET', undefined, {
    allowStatuses: [403, 404, 405],
  });
  if (listed && typeof listed.__unsupportedStatus === 'number') {
    console.log(
      `\n[INFO] n8n /api/v1/credentials listing returned HTTP ${listed.__unsupportedStatus}; ` +
        'proceeding with explicit role-mapped credential IDs and remote node binding checks.',
    );
    return creds;
  }

  const items = Array.isArray(listed?.data)
    ? listed.data
    : Array.isArray(listed)
      ? listed
      : [];
  if (items.length === 0) {
    console.log(
      '\n[INFO] n8n /api/v1/credentials returned no list entries; ' +
        'proceeding with explicit role-mapped credential IDs.',
    );
    return creds;
  }

  const byId = new Map(items.map((item) => [String(item.id || '').trim(), item]));
  const updated = { ...creds };
  for (const [role, cred] of Object.entries(creds)) {
    const remoteCred = byId.get(cred.id);
    if (!remoteCred) {
      failAndExit(
        `Credential ID "${cred.id}" specified for role "${role}" does not exist on n8n.`,
      );
    }
    if (String(remoteCred.type || '') !== cred.type) {
      failAndExit(
        `Credential ID "${cred.id}" (${role}) has n8n type "${remoteCred.type}", expected "${cred.type}".`,
      );
    }
    updated[role] = {
      ...cred,
      name: String(remoteCred.name || cred.name),
    };
  }
  console.log('\n[PASS] Verified all 6 credentials exist on n8n with expected types.');
  return updated;
}

function verifyBoundCredentials(role, wf, creds) {
  const errors = [];
  for (const node of wf.nodes || []) {
    const credentials = node.credentials || {};
    for (const [ctype, cval] of Object.entries(credentials)) {
      const cid = String(cval?.id || '').trim();
      if (!cid || cid.startsWith('CONFIGURE_')) {
        errors.push(`${role}: Node "${node.name}" has unbound ${ctype} credential "${cid || 'empty'}".`);
        continue;
      }
      if (ctype === 'httpCustomAuth' && cid !== creds.supabase.id) {
        errors.push(`${role}: Node "${node.name}" uses ${ctype}="${cid}", expected "${creds.supabase.id}".`);
      } else if (ctype === 'httpBasicAuth' && cid !== creds.cloudinary.id) {
        errors.push(`${role}: Node "${node.name}" uses ${ctype}="${cid}", expected "${creds.cloudinary.id}".`);
      } else if (ctype === 'googleSheetsOAuth2Api' && cid !== creds.sheets.id) {
        errors.push(`${role}: Node "${node.name}" uses ${ctype}="${cid}", expected "${creds.sheets.id}".`);
      } else if (ctype === 'httpHeaderAuth') {
        const headerRole = classifyHeaderRole(node);
        if (headerRole === 'unknown') {
          errors.push(`${role}: Node "${node.name}" uses httpHeaderAuth="${cid}" with unrecognized role.`);
        } else if (cid !== creds[headerRole].id) {
          errors.push(
            `${role}: Node "${node.name}" (${headerRole}) uses httpHeaderAuth="${cid}", ` +
              `expected "${creds[headerRole].id}".`,
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n- '));
  }
}

function validateGraphAndSafety(role, wf, expectedNodes, expectedActive, creds) {
  const actualNodes = Array.isArray(wf.nodes) ? wf.nodes.length : 0;
  if (actualNodes !== expectedNodes) {
    throw new Error(`${role}: Expected exact canonical node count ${expectedNodes}, got ${actualNodes}.`);
  }
  if (Boolean(wf.active) !== expectedActive) {
    throw new Error(`${role}: Expected active=${expectedActive}, got active=${Boolean(wf.active)}.`);
  }

  const normalizedForExport = wf.active === false ? wf : { ...wf, active: false };
  assertVerifiedWorkflowExport(role, normalizedForExport);

  const insp = inspectWorkflowGraph(wf);
  if (
    insp.errors.length > 0 ||
    insp.triggerCount !== 1 ||
    insp.unreachableNodeCount > 0 ||
    insp.unboundPlaceholders.length > 0 ||
    insp.hasDuplicateNodeNames ||
    insp.hasDuplicateNodeIds ||
    insp.hasBrokenConnections ||
    insp.hasLegacyIfSchema ||
    !insp.hasWebhookAuth ||
    (role === 'W03' && !insp.disabledCronTriggers)
  ) {
    throw new Error(`${role} failed graph integrity check: ${JSON.stringify(insp)}`);
  }

  verifyBoundCredentials(role, wf, creds);
}

function preparePayloads(targets, creds) {
  const prepared = [];
  for (const t of targets) {
    const absFile = path.join(ROOT_DIR, t.file);
    if (!fs.existsSync(absFile)) {
      throw new Error(`Missing canonical workflow file: ${t.file}`);
    }
    const wf = JSON.parse(fs.readFileSync(absFile, 'utf8'));

    for (const node of wf.nodes || []) {
      if (!node.credentials) continue;
      for (const [ctype, cval] of Object.entries(node.credentials)) {
        const cid = String(cval?.id || '').trim();
        if (ctype === 'httpCustomAuth') {
          node.credentials[ctype] = { id: creds.supabase.id, name: creds.supabase.name };
        } else if (ctype === 'httpBasicAuth') {
          node.credentials[ctype] = { id: creds.cloudinary.id, name: creds.cloudinary.name };
        } else if (ctype === 'googleSheetsOAuth2Api') {
          node.credentials[ctype] = { id: creds.sheets.id, name: creds.sheets.name };
        } else if (ctype === 'httpHeaderAuth') {
          if (cid === 'CONFIGURE_WEBHOOK') {
            node.credentials[ctype] = { id: creds.webhook.id, name: creds.webhook.name };
          } else if (cid === 'CONFIGURE_DOWNLOADER') {
            node.credentials[ctype] = { id: creds.downloader.id, name: creds.downloader.name };
          } else if (cid === 'CONFIGURE_META') {
            node.credentials[ctype] = { id: creds.meta.id, name: creds.meta.name };
          } else {
            throw new Error(
              `${t.role}: Node "${node.name}" has unexpected httpHeaderAuth placeholder "${cid}". ` +
                'Refusing to guess credential mapping.',
            );
          }
        } else {
          throw new Error(`${t.role}: Node "${node.name}" uses unsupported credential type "${ctype}".`);
        }
      }
    }

    validateGraphAndSafety(t.role, wf, t.expectedNodes, false, creds);
    prepared.push({ ...t, wf });
  }
  return prepared;
}

function writeBackupSnapshot(targets, remoteWfs) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(ROOT_DIR, '.backups', 'n8n', stamp);
  fs.mkdirSync(backupDir, { recursive: true });

  const manifestTargets = [];
  for (const t of targets) {
    const remote = remoteWfs.get(t.role);
    const backupFile = `${t.role}-${t.id}.json`;
    fs.writeFileSync(
      path.join(backupDir, backupFile),
      JSON.stringify(remote, null, 2),
      'utf8',
    );
    manifestTargets.push({
      role: t.role,
      id: t.id,
      name: String(remote.name || t.role),
      previousActive: Boolean(remote.active),
      remoteNodeCount: Array.isArray(remote.nodes) ? remote.nodes.length : 0,
      backupFile,
    });
  }

  fs.writeFileSync(
    path.join(backupDir, 'manifest.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), targets: manifestTargets }, null, 2),
    'utf8',
  );

  return toPosixRel(backupDir);
}

async function checkConflictingExternalWebhooks(n8nReq, managedIds) {
  const listRes = await n8nReq('workflows?limit=250', 'GET', undefined, {
    allowStatuses: [404, 405],
  });
  if (listRes && typeof listRes.__unsupportedStatus === 'number') {
    return;
  }
  const all = Array.isArray(listRes?.data)
    ? listRes.data
    : Array.isArray(listRes)
      ? listRes
      : [];
  const conflicts = [];
  for (const wf of all) {
    const id = String(wf.id || '').trim();
    if (!wf.active || managedIds.has(id)) continue;
    for (const node of wf.nodes || []) {
      if (node.type === 'n8n-nodes-base.webhook') {
        const wPath = String(node.parameters?.path || '').trim().replace(/^\/+/, '');
        if (MANAGED_WEBHOOK_PATHS.has(wPath)) {
          conflicts.push(`${id} ("${wf.name}") owns active webhook "/webhook/${wPath}"`);
        }
      }
    }
  }
  if (conflicts.length > 0) {
    failAndExit(
      `Conflicting active workflows found on n8n outside managed TARGETS:\n- ${conflicts.join('\n- ')}`,
    );
  }
}

async function deactivateAndVerifyInactive(n8nReq, items) {
  console.log('\nStep 1/4: Deactivating active workflows (no errors ignored) and verifying active=false...');
  for (const item of items) {
    const encId = encodeURIComponent(item.id);
    const current = await n8nReq(`workflows/${encId}`, 'GET');
    if (Boolean(current.active)) {
      await n8nReq(`workflows/${encId}/deactivate`, 'POST');
    }
    const verify = await n8nReq(`workflows/${encId}`, 'GET');
    if (verify.active !== false) {
      throw new Error(
        `Safety abort: ${item.role} (${item.id}) remained active (${String(verify.active)}) after deactivation.`,
      );
    }
    console.log(`  [INACTIVE] ${item.role} (${item.id}) verified active=false`);
  }
}

async function runRollback(cfg, n8nReq, rollbackArg) {
  const absDir = path.isAbsolute(rollbackArg) ? rollbackArg : path.join(ROOT_DIR, rollbackArg);
  const manifestPath = path.join(absDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    failAndExit(`Rollback manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = Array.isArray(manifest.targets) ? manifest.targets : [];
  if (entries.length === 0) {
    failAndExit(`Rollback manifest contains zero targets: ${manifestPath}`);
  }

  const restorePlan = [];
  for (const entry of entries) {
    const expectedId = getTargetWorkflowId(cfg, entry.role);
    if (!expectedId || expectedId !== entry.id) {
      failAndExit(
        `Rollback ID mismatch for ${entry.role}: manifest has "${entry.id}", .env.local has "${expectedId}".`,
      );
    }
    const snapPath = path.join(absDir, entry.backupFile);
    if (!fs.existsSync(snapPath)) {
      failAndExit(`Missing backup snapshot file: ${snapPath}`);
    }
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    if (!snap || !Array.isArray(snap.nodes) || !snap.connections) {
      failAndExit(`Corrupt backup snapshot JSON: ${snapPath}`);
    }
    restorePlan.push({
      ...entry,
      snap,
      restoreActive: entry.role === 'W03' ? false : Boolean(entry.previousActive),
    });
  }

  console.log('=== InstaOps v2.0 n8n Workflow Rollback ===');
  console.log(`Restoring ${restorePlan.length} workflows from ${toPosixRel(absDir)}`);

  await deactivateAndVerifyInactive(n8nReq, restorePlan);

  for (const item of restorePlan) {
    const encId = encodeURIComponent(item.id);
    const pre = await n8nReq(`workflows/${encId}`, 'GET');
    if (pre.active !== false) {
      throw new Error(`Rollback abort: ${item.role} (${item.id}) is not inactive before PUT.`);
    }
    await n8nReq(`workflows/${encId}`, 'PUT', buildPutBody(item.snap));
    if (item.restoreActive) {
      await n8nReq(`workflows/${encId}/activate`, 'POST');
    }
    const after = await n8nReq(`workflows/${encId}`, 'GET');
    const afterNodes = Array.isArray(after.nodes) ? after.nodes.length : 0;
    if (afterNodes !== item.snap.nodes.length || Boolean(after.active) !== item.restoreActive) {
      throw new Error(
        `Rollback verification failed for ${item.role} (${item.id}): ` +
          `nodes=${afterNodes} (expected ${item.snap.nodes.length}), ` +
          `active=${Boolean(after.active)} (expected ${item.restoreActive}).`,
      );
    }
    console.log(
      `  [RESTORED] ${item.role} (${item.id}): nodes=${afterNodes}, active=${Boolean(after.active)}` +
        (item.role === 'W03' ? ' (W03 kept inactive for safety)' : ''),
    );
  }

  console.log('\nRollback complete and verified.');
}

async function main() {
  validateCliArgs();
  const cfg = getConfig();
  if (!cfg.n8nBaseUrl || !cfg.n8nApiKey) {
    failAndExit('Missing N8N_BASE_URL or N8N_API_KEY in .env.local');
  }

  if (APPLY && ROLLBACK_DIR) {
    failAndExit('Cannot combine --apply and --rollback in the same command.');
  }

  const n8nReq = createN8nClient(cfg.n8nBaseUrl, cfg.n8nApiKey);

  if (ROLLBACK_DIR) {
    await runRollback(cfg, n8nReq, ROLLBACK_DIR);
    return;
  }

  console.log('=== InstaOps v2.0 n8n Workflow Inspect & Clean Sync ===');
  console.log(
    `Mode: ${
      APPLY
        ? 'APPLY (strict preflight + backup + deactivate + clean PUT + final GET verification)'
        : 'READ-ONLY INSPECT (no remote changes)'
    }`,
  );

  const resolvedTargets = TARGETS.map((t) => {
    const id = getTargetWorkflowId(cfg, t.role);
    if (!id) {
      failAndExit(`Missing workflow ID for ${t.role} in .env.local`);
    }
    return { ...t, id };
  });

  const remoteWfs = new Map();
  console.log('\nRemote vs Canonical Local Node Counts:');
  for (const t of resolvedTargets) {
    const remote = await n8nReq(`workflows/${encodeURIComponent(t.id)}`, 'GET');
    remoteWfs.set(t.role, remote);
    const local = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, t.file), 'utf8'));
    if (!Array.isArray(local.nodes) || local.nodes.length !== t.expectedNodes) {
      failAndExit(
        `Local file ${t.file} has ${local.nodes?.length ?? 0} nodes, expected canonical ${t.expectedNodes}.`,
      );
    }
    const remoteCount = Array.isArray(remote.nodes) ? remote.nodes.length : 0;
    const statusTag = remoteCount === t.expectedNodes ? 'MATCH' : 'DIFF ';
    console.log(
      `  [${statusTag}] ${t.role} (${t.id}): remote=${remoteCount} nodes (active=${Boolean(remote.active)}) -> canonical=${t.expectedNodes} nodes (target active=${t.activate})`,
    );
  }

  const discovered = collectDiscoveredCredentials(remoteWfs);
  console.log('\nDiscovered Live Credential Bindings on Remote Nodes:');
  for (const [role, map] of Object.entries(discovered)) {
    const list = Array.from(map.values()).map((c) => `${c.id} ("${c.name}")`);
    console.log(
      `  ${role.padEnd(11)}: ${list.length > 0 ? list.join(', ') : '(NONE BOUND)'}`,
    );
  }

  const sharedHeaderWarnings = findSharedHeaderCredentialWarnings(discovered);
  if (sharedHeaderWarnings.length > 0) {
    console.log('\n[ACTION REQUIRED] Shared httpHeaderAuth credential IDs detected across security boundaries:');
    for (const s of sharedHeaderWarnings) {
      console.log(`  - Credential ${s.id} is currently reused across: ${s.roles.join(', ')}`);
    }
  }

  if (!APPLY) {
    console.log('\nInspect complete. No remote workflows were modified.');
    console.log('To cleanly replace all 5 canvases using 3 independent Header Auth credentials, run:');
    console.log(
      '  node scripts/sync-workflows.mjs --apply --webhook-cred=<WEBHOOK_CRED_ID> --downloader-cred=<DOWNLOADER_CRED_ID> --meta-cred=<META_CRED_ID>',
    );
    return;
  }

  // Strictly require 3 explicit, separate Header Auth credentials (never guess or reuse)
  const webhookCred = resolveExplicitHeaderCredential(
    'webhook',
    '--webhook-cred=',
    'InstaOps Webhook Secret (x-dashboard-secret)',
  );
  const downloaderCred = resolveExplicitHeaderCredential(
    'downloader',
    '--downloader-cred=',
    'InstaOps Downloader Bearer Auth',
  );
  const metaCred = resolveExplicitHeaderCredential(
    'meta',
    '--meta-cred=',
    'Meta Graph API Token Auth',
  );

  if (!webhookCred || !downloaderCred || !metaCred) {
    failAndExit(
      'Missing required explicit Header Auth credential flags. All three MUST be provided separately:\n' +
        '  --webhook-cred=<ID>     (Header Name: x-dashboard-secret, Value: N8N_WEBHOOK_SECRET)\n' +
        '  --downloader-cred=<ID>  (Header Name: Authorization, Value: Bearer <DOWNLOADER_API_KEY>)\n' +
        '  --meta-cred=<ID>        (Header Name: Authorization, Value: Bearer <META_GRAPH_TOKEN>)',
    );
  }

  const headerIdSet = new Set([webhookCred.id, downloaderCred.id, metaCred.id]);
  if (headerIdSet.size !== 3) {
    failAndExit(
      'Security violation: --webhook-cred, --downloader-cred, and --meta-cred MUST be 3 distinct credential IDs.',
    );
  }

  const supabaseCred = resolveNonHeaderCredential(
    'supabase',
    '--supabase-cred=',
    'httpCustomAuth',
    'Custom Auth account',
    discovered.supabase,
  );
  const cloudinaryCred = resolveNonHeaderCredential(
    'cloudinary',
    '--cloudinary-cred=',
    'httpBasicAuth',
    'Unnamed credential',
    discovered.cloudinary,
  );
  const sheetsCred = resolveNonHeaderCredential(
    'sheets',
    '--sheets-cred=',
    'googleSheetsOAuth2Api',
    'Google Sheets account',
    discovered.sheets,
  );

  const allSixIds = new Set([
    webhookCred.id,
    downloaderCred.id,
    metaCred.id,
    supabaseCred.id,
    cloudinaryCred.id,
    sheetsCred.id,
  ]);
  if (allSixIds.size !== 6) {
    failAndExit('Credential collision: all 6 provider-role credential IDs must be mutually distinct.');
  }

  let creds = {
    webhook: webhookCred,
    downloader: downloaderCred,
    meta: metaCred,
    supabase: supabaseCred,
    cloudinary: cloudinaryCred,
    sheets: sheetsCred,
  };

  creds = await validateCredentialsWithN8n(n8nReq, creds);
  await checkConflictingExternalWebhooks(
    n8nReq,
    new Set(resolvedTargets.map((t) => t.id)),
  );

  console.log('\nResolved Explicit Provider-Role Credential Mapping:');
  for (const [role, cred] of Object.entries(creds)) {
    console.log(`  ${role.padEnd(11)} (${cred.type.padEnd(21)}): ${cred.id} ("${cred.name}")`);
  }

  // Validate all 5 local canonical replacement payloads BEFORE backing up or modifying remote state
  console.log('\nValidating all 5 canonical local payloads before touching remote workflows...');
  const prepared = preparePayloads(resolvedTargets, creds);
  for (const item of prepared) {
    console.log(
      `  [VALIDATED] ${item.role}: ${item.wf.name} (${item.wf.nodes.length} nodes, target active=${item.activate})`,
    );
  }

  // Backup existing remote workflows before any deactivation or PUT
  const relBackupDir = writeBackupSnapshot(resolvedTargets, remoteWfs);
  const rollbackCmd = `node scripts/sync-workflows.mjs --rollback="${relBackupDir}"`;
  console.log(`\n[BACKUP] Saved full remote snapshots and manifest to ${relBackupDir}`);
  console.log(`[RECOVERY COMMAND] If needed later, run:\n  ${rollbackCmd}`);

  let mutationStarted = false;
  try {
    mutationStarted = true;
    await deactivateAndVerifyInactive(n8nReq, prepared);

    console.log('\nStep 2/4: Replacing remote workflow canvases (PUT) while preserving workflow IDs...');
    for (const item of prepared) {
      const encId = encodeURIComponent(item.id);
      const prePut = await n8nReq(`workflows/${encId}`, 'GET');
      if (prePut.active !== false) {
        throw new Error(`Refusing PUT: ${item.role} (${item.id}) is not inactive before replacement.`);
      }
      await n8nReq(`workflows/${encId}`, 'PUT', buildPutBody(item.wf));
      const postPut = await n8nReq(`workflows/${encId}`, 'GET');
      const postCount = Array.isArray(postPut.nodes) ? postPut.nodes.length : 0;
      if (postCount !== item.expectedNodes || postPut.active !== false) {
        throw new Error(
          `Post-PUT check failed for ${item.role} (${item.id}): nodes=${postCount} (expected ${item.expectedNodes}), active=${String(postPut.active)}.`,
        );
      }
      console.log(`  [REPLACED] ${item.role} (${item.id}): nodes=${postCount}, active=false`);
    }

    console.log('\nStep 3/4: Activating runtime webhooks (keeping W03 scheduled runner inactive)...');
    for (const item of prepared) {
      const encId = encodeURIComponent(item.id);
      if (item.activate) {
        await n8nReq(`workflows/${encId}/activate`, 'POST');
        console.log(`  [ACTIVATED] ${item.role} (${item.id})`);
      } else {
        console.log(`  [PAUSED]    ${item.role} (${item.id}) kept inactive (safe default)`);
      }
    }

    console.log('\nStep 4/4: Verifying final remote workflow contents, credentials, and activation states...');
    for (const item of prepared) {
      const encId = encodeURIComponent(item.id);
      const finalWf = await n8nReq(`workflows/${encId}`, 'GET');
      validateGraphAndSafety(item.role, finalWf, item.expectedNodes, item.activate, creds);
      console.log(
        `  [VERIFIED] ${item.role} (${item.id}): nodes=${finalWf.nodes.length}, active=${Boolean(finalWf.active)}, credentials=verified`,
      );
    }
  } catch (err) {
    console.error(`\n[SYNC FAILED] ${err instanceof Error ? err.message : String(err)}`);
    if (mutationStarted) {
      console.error('\n[RECOVERY REQUIRED] Remote state may be partially updated.');
      console.error('Run this exact rollback command to restore all 5 workflows from backup:');
      console.error(`  ${rollbackCmd}`);
    }
    process.exit(1);
  }

  console.log('\nAll 5 remote workflows synced and verified cleanly.');
  console.log('Note: Keep W00 updated manually in n8n UI if using the manual 5-provider test workflow.');
  console.log('Next: Test W00 manually in n8n UI, test invalid secret rejection (403), then run "npm run check:connection".');
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
