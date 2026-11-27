export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  disabled?: boolean;
  alwaysOutputData?: boolean;
  retryOnFail?: boolean;
  continueOnFail?: boolean;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string; name?: string } | unknown>;
}

export interface WorkflowConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export interface WorkflowJson {
  id?: string;
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, { main?: Array<Array<WorkflowConnectionTarget>> }>;
  settings?: Record<string, unknown>;
}

export type WorkflowRole = 'W00' | 'W01' | 'W02' | 'W03' | 'W04' | 'W05';

export interface WorkflowVerificationResult {
  name: string;
  nodeCount: number;
  valid: boolean;
  errors: string[];
}

export interface WorkflowGraphInspection {
  nodeCount: number;
  triggerCount: number;
  webhookPaths: string[];
  hasWebhookAuth: boolean;
  hasLegacyIfSchema: boolean;
  hasDuplicateNodeNames: boolean;
  hasDuplicateNodeIds: boolean;
  hasBrokenConnections: boolean;
  unreachableNodeCount: number;
  unboundPlaceholders: string[];
  disabledCronTriggers: boolean;
  errors: string[];
}

function collectExpressionStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.includes('{{')) {
      out.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExpressionStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectExpressionStrings(v, out);
    }
  }
}

function validateExpressionSyntax(nodeName: string, rawExprStr: string, errors: string[]): void {
  if (rawExprStr.includes('$env')) {
    errors.push(`Node "${nodeName}" references $env inside a parameter expression (blocked when N8N_BLOCK_ENV_ACCESS_IN_NODE=true).`);
  }
  if (rawExprStr.includes('.item.json')) {
    errors.push(`Node "${nodeName}" uses .item.json which breaks inside loops or after HTTP nodes; use .first().json or .last().json.`);
  }
  const stripped = rawExprStr.startsWith('=') ? rawExprStr.slice(1) : rawExprStr;
  const regex = /\{\{([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null = regex.exec(stripped);
  while (match) {
    const inner = (match[1] ?? '').trim();
    if (inner) {
      try {
        new Function('$json', '$input', '$', '$vars', '$now', `return (${inner});`);
      } catch (err) {
        errors.push(
          `Node "${nodeName}" has invalid expression "{{ ${inner} }}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    match = regex.exec(stripped);
  }
}

function getHeaderCredMeta(node: WorkflowNode): { id: string; name: string } {
  const hc = node.credentials?.httpHeaderAuth as { id?: unknown; name?: unknown } | undefined;
  return {
    id: String(hc?.id ?? '').trim(),
    name: String(hc?.name ?? '').trim(),
  };
}

function hasCredential(node: WorkflowNode, credType: string): boolean {
  if (!node.credentials || !node.credentials[credType]) return false;
  if (node.type === 'n8n-nodes-base.webhook') {
    return node.parameters?.authentication === 'headerAuth';
  }
  const params = node.parameters ?? {};
  return params.authentication === 'genericCredentialType' && params.genericAuthType === credType;
}

function nodeReachableBefore(
  wf: WorkflowJson,
  startNodeName: string,
  stopBeforeNodeName: string,
): Set<string> {
  const visited = new Set<string>();
  const queue = [startNodeName];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur) || cur === stopBeforeNodeName) continue;
    visited.add(cur);
    const branches = wf.connections[cur]?.main ?? [];
    for (const branch of branches) {
      for (const edge of branch) {
        if (!visited.has(edge.node)) queue.push(edge.node);
      }
    }
  }
  return visited;
}

/**
 * Inspects node graph structural integrity, trigger/webhook config, IF v2 schemas,
 * expression syntax, and credential placeholders for both local exports and remote n8n JSONs.
 */
export function inspectWorkflowGraph(wf: WorkflowJson): WorkflowGraphInspection {
  const errors: string[] = [];
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  const connections = wf.connections && typeof wf.connections === 'object' ? wf.connections : {};

  const nodeByName = new Map<string, WorkflowNode>();
  const nodeIds = new Set<string>();
  const unboundPlaceholders: string[] = [];
  const webhookPaths: string[] = [];
  let hasDuplicateNodeNames = false;
  let hasDuplicateNodeIds = false;
  let hasLegacyIfSchema = false;
  let hasBrokenConnections = false;
  let hasWebhookAuth = true;
  let triggerCount = 0;
  let disabledCronTriggers = true;
  const triggerNames: string[] = [];

  for (const node of nodes) {
    if (!node.id || !node.name || !node.type) {
      errors.push('Node missing required id/name/type field.');
      continue;
    }
    if (nodeIds.has(node.id)) {
      hasDuplicateNodeIds = true;
      errors.push(`Duplicate node ID "${node.id}" ("${node.name}").`);
    }
    nodeIds.add(node.id);

    if (nodeByName.has(node.name)) {
      hasDuplicateNodeNames = true;
      errors.push(`Duplicate node name "${node.name}".`);
    }
    nodeByName.set(node.name, node);

    if (
      node.type === 'n8n-nodes-base.webhook' ||
      node.type === 'n8n-nodes-base.scheduleTrigger' ||
      node.type === 'n8n-nodes-base.manualTrigger'
    ) {
      triggerCount += 1;
      triggerNames.push(node.name);
    }

    if (node.type === 'n8n-nodes-base.webhook') {
      const p = String(node.parameters?.path ?? '').trim();
      if (p) webhookPaths.push(p);
      if (node.parameters?.authentication !== 'headerAuth' || !hasCredential(node, 'httpHeaderAuth')) {
        hasWebhookAuth = false;
        errors.push(`Webhook "${node.name}" must enforce native authentication="headerAuth" with httpHeaderAuth credential.`);
      }
    }

    if (node.type === 'n8n-nodes-base.scheduleTrigger' && node.disabled !== true) {
      disabledCronTriggers = false;
    }

    if (node.type === 'n8n-nodes-base.if') {
      const conds = node.parameters?.conditions as Record<string, unknown> | undefined;
      const hasV2Arr = Boolean(conds && Array.isArray(conds.conditions) && conds.conditions.length > 0);
      const hasLegacyObj = Boolean(conds && (conds.boolean || conds.string || conds.number));
      if ((node.typeVersion ?? 0) !== 2 || !hasV2Arr || hasLegacyObj) {
        hasLegacyIfSchema = true;
        errors.push(`IF node "${node.name}" must use typeVersion=2 with conditions.conditions[] (no legacy boolean/string conditions).`);
      }
    }

    if (node.type === 'n8n-nodes-base.switch' && (node.typeVersion ?? 0) < 3) {
      errors.push(`Switch node "${node.name}" must use typeVersion >= 3.`);
    }

    if (node.credentials && typeof node.credentials === 'object') {
      for (const [ctype, credVal] of Object.entries(node.credentials)) {
        const cid = String((credVal as { id?: unknown } | undefined)?.id ?? '').trim();
        if (cid.startsWith('CONFIGURE_')) {
          unboundPlaceholders.push(`${node.name}:${ctype}=${cid}`);
        }
      }
    }
  }

  for (const [source, conn] of Object.entries(connections)) {
    if (!nodeByName.has(source)) {
      hasBrokenConnections = true;
      errors.push(`Connection source "${source}" does not match any node name.`);
    }
    const branches = conn?.main ?? [];
    for (const branch of branches) {
      for (const edge of branch) {
        if (!nodeByName.has(edge.node)) {
          hasBrokenConnections = true;
          errors.push(`Connection from "${source}" targets unknown node "${edge.node}".`);
        }
      }
    }
  }

  let unreachableNodeCount = 0;
  if (nodes.length > 0 && triggerNames.length > 0) {
    const visited = new Set<string>();
    const queue = [...triggerNames];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const branches = connections[cur]?.main ?? [];
      for (const branch of branches) {
        for (const edge of branch) {
          if (!visited.has(edge.node) && nodeByName.has(edge.node)) queue.push(edge.node);
        }
      }
    }
    unreachableNodeCount = Math.max(0, nodeByName.size - visited.size);
    if (unreachableNodeCount > 0) {
      errors.push(`Workflow has ${unreachableNodeCount} unreachable/disconnected node(s) (possible duplicate canvas import).`);
    }
  }

  if (nodes.length > 0 && triggerCount !== 1) {
    errors.push(`Workflow must contain exactly 1 trigger node (found ${triggerCount}).`);
  }

  return {
    nodeCount: nodes.length,
    triggerCount,
    webhookPaths,
    hasWebhookAuth,
    hasLegacyIfSchema,
    hasDuplicateNodeNames,
    hasDuplicateNodeIds,
    hasBrokenConnections,
    unreachableNodeCount,
    unboundPlaceholders,
    disabledCronTriggers,
    errors,
  };
}

/**
 * Validates exported n8n workflow JSONs against InstaOps v2.0 security, concurrency,
 * native n8n HTTP Request / Wait node compatibility, credential separation, and runtime invariants.
 */
export function verifyWorkflowExport(role: WorkflowRole, wf: WorkflowJson): WorkflowVerificationResult {
  const errors: string[] = [];

  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes) || !wf.connections) {
    return {
      name: wf?.name ?? role,
      nodeCount: 0,
      valid: false,
      errors: [`${role}: Invalid workflow JSON structure (missing nodes or connections).`],
    };
  }

  if (wf.active !== false) {
    errors.push(`${role}: Exported workflow must default to active=false until credentials are verified.`);
  }

  if (wf.nodes.length === 0) {
    errors.push(`${role}: Workflow contains zero nodes.`);
  }

  const serialized = JSON.stringify(wf);
  if (serialized.includes('instagram-downloader-psi-one.vercel.app')) {
    errors.push(`${role}: Workflow still references deprecated downloader URL instagram-downloader-psi-one.vercel.app.`);
  }

  const graph = inspectWorkflowGraph(wf);
  for (const err of graph.errors) {
    errors.push(`${role}: ${err}`);
  }

  const nodeByName = new Map<string, WorkflowNode>();
  const codeJsList: Array<{ name: string; js: string }> = [];
  const httpNodes: WorkflowNode[] = [];
  const waitNodes: WorkflowNode[] = [];
  const webhookHeaderCredIds = new Set<string>();
  const metaHeaderCredIds = new Set<string>();
  const downloaderHeaderCredIds = new Set<string>();

  for (const node of wf.nodes) {
    if (!node.id || !node.name || !node.type) continue;
    nodeByName.set(node.name, node);

    if (node.type === 'n8n-nodes-base.webhook') {
      const hc = getHeaderCredMeta(node);
      if (hc.id) webhookHeaderCredIds.add(hc.id);
      if (hc.id === 'CONFIGURE_META' || hc.id === 'CONFIGURE_DOWNLOADER') {
        errors.push(`${role}: Webhook "${node.name}" must use CONFIGURE_WEBHOOK (never Meta or Downloader credentials).`);
      }
    }

    if (node.type === 'n8n-nodes-base.code') {
      const jsCode = String(node.parameters?.jsCode ?? '');
      if (!jsCode.trim()) {
        errors.push(`${role}: Code node "${node.name}" is empty.`);
        continue;
      }
      if (/helpers\.httpRequest/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" uses helpers.httpRequest; external HTTP calls must use native HTTP Request nodes.`);
      }
      if (/\bfetch\s*\(/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" calls fetch(); external HTTP calls must use native HTTP Request nodes.`);
      }
      if (/\.item\.json\b/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" uses .item.json which is fragile inside loops/HTTP flows.`);
      }
      if (/N8N_WEBHOOK_SECRET|cldSecCfg|cldKeyCfg/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" must NOT access N8N_WEBHOOK_SECRET or Cloudinary API secrets directly; use native credentials.`);
      }

      try {
        new Function('$input', '$json', '$vars', '$env', '$execution', '$', jsCode);
      } catch (err) {
        errors.push(
          `${role}: Code node "${node.name}" has JS syntax error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      codeJsList.push({ name: node.name, js: jsCode });
    } else {
      const exprs: string[] = [];
      collectExpressionStrings(node.parameters ?? {}, exprs);
      for (const expr of exprs) {
        validateExpressionSyntax(node.name, expr, errors);
      }
    }

    if (node.type === 'n8n-nodes-base.httpRequest') {
      httpNodes.push(node);
      if ((node.typeVersion ?? 0) < 4.2) {
        errors.push(`${role}: HTTP Request node "${node.name}" should use typeVersion >= 4.2.`);
      }
      const urlExpr = String(node.parameters?.url ?? '');
      if (urlExpr.includes('sb_url') || urlExpr.includes('/rest/v1/') || urlExpr.includes('supabase.co')) {
        if (!hasCredential(node, 'httpCustomAuth')) {
          errors.push(`${role}: Supabase HTTP node "${node.name}" must bind httpCustomAuth credential.`);
        }
      } else if (urlExpr.includes('graph.facebook.com') || urlExpr.includes('graph_url') || urlExpr.includes('poll_url')) {
        if (!hasCredential(node, 'httpHeaderAuth')) {
          errors.push(`${role}: Meta Graph HTTP node "${node.name}" must bind httpHeaderAuth credential.`);
        }
        const hc = getHeaderCredMeta(node);
        if (hc.id) metaHeaderCredIds.add(hc.id);
        if (hc.id === 'CONFIGURE_DOWNLOADER' || hc.id === 'CONFIGURE_WEBHOOK') {
          errors.push(`${role}: Meta Graph node "${node.name}" must use Meta credential (CONFIGURE_META), not ${hc.id}.`);
        }
      } else if (urlExpr.includes('/api/n8n/resolve') || urlExpr.includes('dl_url')) {
        if (!hasCredential(node, 'httpHeaderAuth')) {
          errors.push(`${role}: Downloader HTTP node "${node.name}" must bind httpHeaderAuth credential.`);
        }
        const hc = getHeaderCredMeta(node);
        if (hc.id) downloaderHeaderCredIds.add(hc.id);
        if (hc.id === 'CONFIGURE_META' || hc.id === 'CONFIGURE_WEBHOOK') {
          errors.push(`${role}: Downloader node "${node.name}" must use Downloader credential (CONFIGURE_DOWNLOADER), not ${hc.id}.`);
        }
      } else if (urlExpr.includes('/webhook/instaops-')) {
        if (!hasCredential(node, 'httpHeaderAuth')) {
          errors.push(`${role}: Internal webhook call "${node.name}" must bind httpHeaderAuth credential.`);
        }
        const hc = getHeaderCredMeta(node);
        if (hc.id) webhookHeaderCredIds.add(hc.id);
        if (hc.id === 'CONFIGURE_META' || hc.id === 'CONFIGURE_DOWNLOADER') {
          errors.push(`${role}: Internal webhook call "${node.name}" must use CONFIGURE_WEBHOOK.`);
        }
      } else if (
        urlExpr.includes('api.cloudinary.com') ||
        urlExpr.includes('upload_url') ||
        urlExpr.includes('destroy_url')
      ) {
        if (!hasCredential(node, 'httpBasicAuth')) {
          errors.push(`${role}: Cloudinary HTTP node "${node.name}" must bind httpBasicAuth credential.`);
        }
      }
    }

    if (node.type === 'n8n-nodes-base.wait') {
      waitNodes.push(node);
    }
  }

  for (const wid of webhookHeaderCredIds) {
    if (metaHeaderCredIds.has(wid)) {
      errors.push(`${role}: Header Auth credential ${wid} is reused across Webhook and Meta Graph roles.`);
    }
    if (downloaderHeaderCredIds.has(wid)) {
      errors.push(`${role}: Header Auth credential ${wid} is reused across Webhook and Downloader roles.`);
    }
  }
  for (const mid of metaHeaderCredIds) {
    if (downloaderHeaderCredIds.has(mid)) {
      errors.push(`${role}: Header Auth credential ${mid} is reused across Meta Graph and Downloader roles.`);
    }
  }

  const allCodeText = codeJsList.map((c) => c.js).join('\n');
  const allHttpUrls = httpNodes.map((n) => String(n.parameters?.url ?? '')).join('\n');

  if (role === 'W00') {
    if (!allCodeText.includes('INSTAOPS_V2_CREDENTIAL_CHECK')) {
      errors.push('W00: Missing INSTAOPS_V2_CREDENTIAL_CHECK marker.');
    }
    for (const reqPath of ['supabase.co', '/api/n8n/resolve', 'api.cloudinary.com', 'graph.facebook.com']) {
      if (!allHttpUrls.includes(reqPath)) {
        errors.push(`W00: Missing probe node calling "${reqPath}".`);
      }
    }
    if (!wf.nodes.some((n) => n.type === 'n8n-nodes-base.googleSheets')) {
      errors.push('W00: Missing Google Sheets read probe.');
    }
  }

  if (role === 'W01') {
    if (!allCodeText.includes('INSTAOPS_V2_EXTRACT')) {
      errors.push('W01: Missing INSTAOPS_V2_EXTRACT safeguard marker.');
    }
    if (!allCodeText.includes('https://ig-dowloader-nnnn.vercel.app')) {
      errors.push('W01: Default DOWNLOADER_BASE_URL must be https://ig-dowloader-nnnn.vercel.app.');
    }
    if (allHttpUrls.includes('graph.facebook.com') || serialized.includes('media_publish')) {
      errors.push('W01: Extract workflow must NOT contain Meta Graph publishing calls.');
    }
    for (const reqPath of [
      'instaops_transfer_or_claim_lock',
      '/api/n8n/resolve',
      'upload_url',
      'instaops_renew_lock',
      'instaops_finalize_extraction',
    ]) {
      if (!allHttpUrls.includes(reqPath)) {
        errors.push(`W01: Missing native HTTP Request node calling "${reqPath}".`);
      }
    }
    if (
      !allCodeText.includes('api.cloudinary.com/v1_1/') ||
      !httpNodes.some((n) => String(n.parameters?.url ?? '').includes('upload_url') && n.parameters?.contentType === 'form-urlencoded')
    ) {
      errors.push('W01: Cloudinary upload must use native form-urlencoded HTTP Request targeting api.cloudinary.com/v1_1/.');
    }
    if (!allCodeText.includes('instaops-v2/')) {
      errors.push('W01: Cloudinary uploads must use the instaops-v2/ asset namespace.');
    }
    if (!allCodeText.includes('DATABASE_WRITE_NOT_VERIFIED') || !allCodeText.includes('LOCK_RENEWAL_UNVERIFIED')) {
      errors.push('W01: Missing critical CHECK verification guards for DB writes or lock renewals.');
    }
  }

  if (role === 'W02') {
    if (!allCodeText.includes('INSTAOPS_V2_PUBLISH')) {
      errors.push('W02: Missing INSTAOPS_V2_PUBLISH safeguard marker.');
    }
    if (!allCodeText.includes('LIVE_PUBLISH_ENABLED') || !allCodeText.includes('reqRev !== currentRev || approvedRev !== currentRev')) {
      errors.push('W02: Missing LIVE_PUBLISH_ENABLED gate or logical-OR revision check.');
    }
    if (!allHttpUrls.includes('instaops_get_runtime_settings')) {
      errors.push('W02: Must read authoritative runtime settings from Supabase RPC instaops_get_runtime_settings before gating publish.');
    }
    if (waitNodes.length < 2) {
      errors.push('W02: Expected native Wait nodes for both carousel child polling and parent container polling.');
    }
    for (const reqPath of [
      'instaops_transfer_or_claim_lock',
      'instaops_renew_lock',
      'instaops_release_lock',
      '/media_publish',
    ]) {
      if (!allHttpUrls.includes(reqPath)) {
        errors.push(`W02: Missing native HTTP Request node calling "${reqPath}".`);
      }
    }
    if (!allCodeText.includes('VERIFY_MANUALLY') || !allCodeText.includes('PUBLISH_OUTCOME_UNKNOWN')) {
      errors.push('W02: Uncertain publication outcomes must preserve lock and mark VERIFY_MANUALLY / PUBLISH_OUTCOME_UNKNOWN.');
    }
    if (!allCodeText.includes('PUBLISHED_ID_CHECKPOINT_UNVERIFIED')) {
      errors.push('W02: Missing CHECK | Persist Published ID Immediately verification guard.');
    }
  }

  if (role === 'W03') {
    const cron = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    if (!cron || cron.disabled !== true) {
      errors.push('W03: Schedule trigger must be present and disabled by default (disabled: true).');
    }
    if (!allCodeText.includes('INSTAOPS_V2_SCHEDULE') || !allCodeText.includes('scheduling_enabled') || !allCodeText.includes('live_publish_enabled')) {
      errors.push('W03: Missing INSTAOPS_V2_SCHEDULE marker or scheduling_enabled + live_publish_enabled DB gate.');
    }
    if (!allHttpUrls.includes('instaops_get_runtime_settings')) {
      errors.push('W03: Scheduled runner must read authoritative Supabase runtime settings RPC.');
    }
    if (!allHttpUrls.includes('instaops_claim_due_scheduled_posts') || !allHttpUrls.includes('instaops-publish-v1')) {
      errors.push('W03: Scheduled runner must claim posts via instaops_claim_due_scheduled_posts and dispatch to W02 webhook.');
    }
  }

  if (role === 'W04') {
    if (!allCodeText.includes('INSTAOPS_V2_CONTENT')) {
      errors.push('W04: Missing INSTAOPS_V2_CONTENT safeguard marker.');
    }
    if (allHttpUrls.includes('graph.facebook.com') || serialized.includes('media_publish')) {
      errors.push('W04: Content management bridge must NOT contain Meta Graph publishing endpoints.');
    }
    if (!allCodeText.includes('LIVE_DELETE_ENABLED') || !allHttpUrls.includes('instaops_get_runtime_settings')) {
      errors.push('W04: Missing LIVE_DELETE_ENABLED gate or authoritative instaops_get_runtime_settings RPC.');
    }
    const sheetsNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
    if (sheetsNodes.length < 4) {
      errors.push('W04: Expected Google Sheets outbox sync nodes across Posts, MediaAssets, ExecutionLogs, and Accounts tabs.');
    }
    for (const reqPath of [
      'instaops_job_locks',
      'instaops_jobs',
      'instaops_acquire_lock',
      'instaops_release_lock',
      'instaops_finalize_deletion',
      'destroy_url',
    ]) {
      if (!allHttpUrls.includes(reqPath)) {
        errors.push(`W04: Missing native HTTP Request node calling "${reqPath}".`);
      }
    }
    if (
      !allCodeText.includes('api.cloudinary.com/v1_1/') ||
      !allCodeText.includes('/destroy') ||
      !httpNodes.some((n) => String(n.parameters?.url ?? '').includes('destroy_url') && n.parameters?.contentType === 'form-urlencoded')
    ) {
      errors.push('W04: Cloudinary /destroy must use native form-urlencoded HTTP Request targeting api.cloudinary.com/v1_1/.../destroy.');
    }
    const webhookNode = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
    const destroyNode = httpNodes.find((n) => String(n.parameters?.url ?? '').includes('destroy_url') || n.id === 'w04-del-http');
    if (!webhookNode || !destroyNode) {
      errors.push('W04: Missing webhook trigger or Cloudinary /destroy HTTP Request node.');
    } else {
      const beforeDestroy = nodeReachableBefore(wf, webhookNode.name, destroyNode.name);
      const hasLockCheckBefore = Array.from(beforeDestroy).some((n) => {
        const node = nodeByName.get(n);
        return node?.type === 'n8n-nodes-base.httpRequest' && String(node.parameters?.url ?? '').includes('instaops_job_locks');
      });
      const hasAcquireBefore = Array.from(beforeDestroy).some((n) => {
        const node = nodeByName.get(n);
        return node?.type === 'n8n-nodes-base.httpRequest' && String(node.parameters?.url ?? '').includes('instaops_acquire_lock');
      });
      if (!hasLockCheckBefore || !hasAcquireBefore) {
        errors.push('W04: Cloudinary /destroy MUST NOT execute before Supabase lock verification and direct lock claim.');
      }
    }
  }

  if (role === 'W05') {
    if (!allCodeText.includes('INSTAOPS_V2_RECOVERY')) {
      errors.push('W05: Missing INSTAOPS_V2_RECOVERY marker.');
    }
    if (!allHttpUrls.includes('instaops_verify_health_and_rpc') || !allHttpUrls.includes('instaops_get_runtime_settings')) {
      errors.push('W05: Recovery workflow must check Supabase RPC health and runtime settings.');
    }
    const postsProbe = wf.nodes.find((n) => n.type === 'n8n-nodes-base.googleSheets');
    if (!postsProbe || postsProbe.alwaysOutputData !== true) {
      errors.push('W05: Google Sheets Posts probe must enable alwaysOutputData=true.');
    }
    for (const c of codeJsList) {
      if (/\|\|\s*[A-Za-z0-9_]+\s*\[\s*0\s*\]/.test(c.js)) {
        errors.push(`W05: Code node "${c.name}" contains forbidden [0] fallback matching.`);
      }
    }
    const strictMatchNode = codeJsList.find((c) => c.name.includes('Strict Container & Publication Match'));
    if (!strictMatchNode || !strictMatchNode.js.includes('VERIFY_MANUALLY') || !strictMatchNode.js.includes('verified: false')) {
      errors.push('W05: Strict Container & Publication Match must never infer publication from feed similarity and must retain VERIFY_MANUALLY.');
    }
    if (!allCodeText.includes('ownerMatch') || !allCodeText.includes('dupConflict') || !allCodeText.includes('DATABASE_WRITE_NOT_VERIFIED')) {
      errors.push('W05: Explicit media reconciliation must verify destination ownership, duplicate published_id conflicts, and DB persistence.');
    }
  }

  return {
    name: wf.name,
    nodeCount: wf.nodes.length,
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Throws an Error with detailed failure list when a workflow export violates safety checks.
 */
export function assertVerifiedWorkflowExport(role: WorkflowRole, wf: WorkflowJson): void {
  const result = verifyWorkflowExport(role, wf);
  if (!result.valid) {
    throw new Error(`Workflow verification failed for ${role} (${result.name}):\n- ${result.errors.join('\n- ')}`);
  }
}
