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
  credentials?: Record<string, unknown>;
}

export interface WorkflowConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export interface WorkflowJson {
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, { main?: Array<Array<WorkflowConnectionTarget>> }>;
  settings?: Record<string, unknown>;
}

export type WorkflowRole = 'W01' | 'W02' | 'W03' | 'W04' | 'W05';

export interface WorkflowVerificationResult {
  name: string;
  nodeCount: number;
  valid: boolean;
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
        // Validate JS syntax parses cleanly under n8n expression variables
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

function hasCredential(node: WorkflowNode, credType: string): boolean {
  if (!node.credentials || !node.credentials[credType]) return false;
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
 * Validates exported n8n workflow JSONs against InstaOps v2.0 security, concurrency,
 * native n8n HTTP Request / Wait node compatibility, and runtime invariants.
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
    errors.push(`${role}: Exported workflow must default to active=false until credentials & env vars are configured.`);
  }

  if (wf.nodes.length === 0) {
    errors.push(`${role}: Workflow contains zero nodes.`);
  }

  const serialized = JSON.stringify(wf);
  if (serialized.includes('instagram-downloader-psi-one.vercel.app')) {
    errors.push(`${role}: Workflow still references deprecated downloader URL instagram-downloader-psi-one.vercel.app.`);
  }

  const nodeByName = new Map<string, WorkflowNode>();
  const codeJsList: Array<{ name: string; js: string }> = [];
  const httpNodes: WorkflowNode[] = [];
  const waitNodes: WorkflowNode[] = [];

  for (const node of wf.nodes) {
    if (!node.id || !node.name || !node.type) {
      errors.push(`${role}: Node missing required id/name/type field.`);
      continue;
    }
    if (nodeByName.has(node.name)) {
      errors.push(`${role}: Duplicate node name "${node.name}".`);
    }
    nodeByName.set(node.name, node);

    if (node.type === 'n8n-nodes-base.code') {
      const jsCode = String(node.parameters?.jsCode ?? '');
      if (!jsCode.trim()) {
        errors.push(`${role}: Code node "${node.name}" is empty.`);
        continue;
      }

      // Blocker #1: ZERO helpers.httpRequest or fetch() in Code nodes
      if (/helpers\.httpRequest/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" uses helpers.httpRequest; external HTTP calls must use native HTTP Request nodes.`);
      }
      if (/\bfetch\s*\(/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" calls fetch(); external HTTP calls must use native HTTP Request nodes.`);
      }
      if (/\.item\.json\b/.test(jsCode)) {
        errors.push(`${role}: Code node "${node.name}" uses .item.json which is fragile inside loops/HTTP flows.`);
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
      if (urlExpr.includes('sb_url') || urlExpr.includes('/rest/v1/')) {
        if (!hasCredential(node, 'httpCustomAuth')) {
          errors.push(`${role}: Supabase HTTP node "${node.name}" must bind httpCustomAuth credential.`);
        }
      } else if (
        urlExpr.includes('graph.facebook.com') ||
        urlExpr.includes('/api/n8n/resolve') ||
        urlExpr.includes('/webhook/instaops-publish-v1')
      ) {
        if (!hasCredential(node, 'httpHeaderAuth')) {
          errors.push(`${role}: API HTTP node "${node.name}" must bind httpHeaderAuth credential.`);
        }
      } else if (urlExpr.includes('api.cloudinary.com') && urlExpr.includes('/usage')) {
        if (!hasCredential(node, 'httpBasicAuth')) {
          errors.push(`${role}: Cloudinary usage HTTP node "${node.name}" must bind httpBasicAuth credential.`);
        }
      }
    }

    if (node.type === 'n8n-nodes-base.wait') {
      waitNodes.push(node);
    }
  }

  for (const [source, conn] of Object.entries(wf.connections)) {
    if (!nodeByName.has(source)) {
      errors.push(`${role}: Connection source "${source}" does not match any node name.`);
    }
    const branches = conn?.main ?? [];
    for (const branch of branches) {
      for (const edge of branch) {
        if (!nodeByName.has(edge.node)) {
          errors.push(`${role}: Connection from "${source}" targets unknown node "${edge.node}".`);
        }
      }
    }
  }

  const allCodeText = codeJsList.map((c) => c.js).join('\n');
  const allHttpUrls = httpNodes.map((n) => String(n.parameters?.url ?? '')).join('\n');

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
    if (!allCodeText.includes('api.cloudinary.com/v1_1/') || !httpNodes.some((n) => String(n.parameters?.url ?? '').includes('upload_url') && n.parameters?.contentType === 'form-urlencoded')) {
      errors.push('W01: Cloudinary upload must use native form-urlencoded HTTP Request targeting api.cloudinary.com/v1_1/.');
    }
    if (!allCodeText.includes('instaops-v2/')) {
      errors.push('W01: Cloudinary uploads must use the instaops-v2/ asset namespace.');
    }
  }

  if (role === 'W02') {
    if (!allCodeText.includes('INSTAOPS_V2_PUBLISH')) {
      errors.push('W02: Missing INSTAOPS_V2_PUBLISH safeguard marker.');
    }
    if (!allCodeText.includes('LIVE_PUBLISH_ENABLED') || !allCodeText.includes('reqRev !== currentRev || approvedRev !== currentRev')) {
      errors.push('W02: Missing LIVE_PUBLISH_ENABLED gate or logical-OR revision check.');
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
  }

  if (role === 'W03') {
    const cron = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    if (!cron || cron.disabled !== true) {
      errors.push('W03: Schedule trigger must be present and disabled by default (disabled: true).');
    }
    if (!allCodeText.includes('INSTAOPS_V2_SCHEDULE') || !allCodeText.includes('SCHEDULING_ENABLED')) {
      errors.push('W03: Missing INSTAOPS_V2_SCHEDULE marker or SCHEDULING_ENABLED gate.');
    }
    if (!allHttpUrls.includes('instaops_claim_due_scheduled_posts') || !allHttpUrls.includes('instaops-publish-v1')) {
      errors.push('W03: Scheduled runner must claim posts via instaops_claim_due_scheduled_posts and dispatch to W02 webhook.');
    }
  }

  if (role === 'W04') {
    if (allHttpUrls.includes('graph.facebook.com') || serialized.includes('media_publish')) {
      errors.push('W04: Content management bridge must NOT contain Meta Graph publishing endpoints.');
    }
    if (!allCodeText.includes('LIVE_DELETE_ENABLED')) {
      errors.push('W04: Missing LIVE_DELETE_ENABLED deletion gate.');
    }
    const sheetsNodes = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets');
    if (sheetsNodes.length < 4) {
      errors.push('W04: Expected Google Sheets outbox sync nodes across Posts, MediaAssets, ExecutionLogs, and Accounts tabs.');
    }
    for (const reqPath of ['instaops_job_locks', 'instaops_jobs', 'instaops_acquire_lock', 'instaops_release_lock', 'destroy_url']) {
      if (!allHttpUrls.includes(reqPath)) {
        errors.push(`W04: Missing native HTTP Request node calling "${reqPath}" for pre-delete lock enforcement.`);
      }
    }
    if (!allCodeText.includes('api.cloudinary.com/v1_1/') || !allCodeText.includes('/destroy') || !httpNodes.some((n) => String(n.parameters?.url ?? '').includes('destroy_url') && n.parameters?.contentType === 'form-urlencoded')) {
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
    if (!allHttpUrls.includes('instaops_verify_health_and_rpc')) {
      errors.push('W05: Recovery workflow must check Supabase RPC health via instaops_verify_health_and_rpc.');
    }
    const postsProbe = wf.nodes.find((n) => n.type === 'n8n-nodes-base.googleSheets');
    if (!postsProbe || postsProbe.alwaysOutputData !== true) {
      errors.push('W05: Google Sheets Posts probe must enable alwaysOutputData=true.');
    }
    // Blocker #2: NEVER allow list[0] / || arr[0] fallback in W05 matching
    for (const c of codeJsList) {
      if (/\|\|\s*[A-Za-z0-9_]+\s*\[\s*0\s*\]/.test(c.js)) {
        errors.push(`W05: Code node "${c.name}" contains forbidden [0] fallback matching.`);
      }
    }
    if (!allCodeText.includes('matches.length !== 1') || !allCodeText.includes('VERIFY_MANUALLY')) {
      errors.push('W05: Reconciliation must enforce exact 1-of-1 unambiguous match (matches.length !== 1) and retain VERIFY_MANUALLY.');
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
