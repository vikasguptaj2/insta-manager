import { AppError } from '../errors/codes';

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

export interface WorkflowJson {
  name: string;
  active: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, { main?: Array<Array<{ node: string; type: string; index: number }>> }>;
  settings?: Record<string, unknown>;
}

export interface WorkflowVerificationResult {
  name: string;
  nodeCount: number;
  valid: boolean;
  errors: string[];
}

const HARDCODED_SECRET_PATTERNS = [
  /Bearer\s+(?!\{\{|\$env|\$vars)[A-Za-z0-9._-]{16,}/i,
  /x-dashboard-secret[^\n]*!==\s*["'][A-Za-z0-9._-]{12,}["']/i,
  /\bEAA[A-Za-z0-9]{20,}\b/,
];

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

function validateGraphBasics(wf: WorkflowJson, label: string, errors: string[]): void {
  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) {
    errors.push(`${label}: Invalid workflow JSON structure.`);
    return;
  }
  if (wf.active !== false) {
    errors.push(`${label}: Exported workflow must default to active: false.`);
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (!n.name || !n.id) errors.push(`${label}: Node missing name or id.`);
    if (names.has(n.name)) errors.push(`${label}: Duplicate node name "${n.name}".`);
    if (ids.has(n.id)) errors.push(`${label}: Duplicate node id "${n.id}".`);
    names.add(n.name);
    ids.add(n.id);

    const js = typeof n.parameters?.jsCode === 'string' ? n.parameters.jsCode : '';
    if (js) {
      try {
        new Function('$', '$input', '$execution', '$env', '$vars', js);
        new AsyncFunction('$', '$input', '$execution', '$env', '$vars', js);
      } catch (e) {
        errors.push(`${label}: Syntax error in Code node "${n.name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const serialized = JSON.stringify(n);
    for (const pat of HARDCODED_SECRET_PATTERNS) {
      if (pat.test(serialized)) {
        errors.push(`${label}: Possible hardcoded credential in node "${n.name}".`);
      }
    }
  }

  for (const [src, conn] of Object.entries(wf.connections ?? {})) {
    if (!names.has(src)) errors.push(`${label}: Connection source "${src}" does not exist.`);
    for (const branch of conn.main ?? []) {
      for (const link of branch) {
        if (!names.has(link.node)) errors.push(`${label}: Connection target "${link.node}" does not exist.`);
      }
    }
  }
}

function combinedCode(wf: WorkflowJson): string {
  return wf.nodes
    .map((n) => (typeof n.parameters?.jsCode === 'string' ? n.parameters.jsCode : ''))
    .join('\n');
}

function hasSheetsNode(wf: WorkflowJson): boolean {
  return wf.nodes.some((n) => n.type === 'n8n-nodes-base.googleSheets');
}

export function verifyWorkflowExport(
  role: 'W01' | 'W02' | 'W03' | 'W04' | 'W05',
  wf: WorkflowJson,
): WorkflowVerificationResult {
  const errors: string[] = [];
  validateGraphBasics(wf, role, errors);
  const allCode = combinedCode(wf);
  const serialized = JSON.stringify(wf);

  if (!allCode.includes('readCfg')) {
    errors.push(`${role}: Code nodes must use safe readCfg ($env/$vars fallback) helper for hosted n8n v2 compatibility.`);
  }

  if (role === 'W01') {
    if (!allCode.includes('INSTAOPS_V2_EXTRACT')) {
      errors.push('W01: Missing INSTAOPS_V2_EXTRACT safeguard marker.');
    }
    if (/media_publish|INSTAGRAM\s*\|/i.test(serialized)) {
      errors.push('W01: Extraction workflow must never contain Instagram publishing nodes.');
    }
    if (hasSheetsNode(wf)) {
      errors.push('W01: Must not contain competing direct Google Sheets nodes (outbox sync belongs strictly to W04).');
    }
    if (!serialized.includes('/api/n8n/resolve')) {
      errors.push('W01: Must integrate with hosted downloader /api/n8n/resolve endpoint.');
    }
    if (!serialized.includes('instaops_transfer_or_claim_lock') || !serialized.includes('instaops_finalize_extraction')) {
      errors.push('W01: Must execute atomic lock transfer and transactional extraction finalization RPCs.');
    }
    if (!serialized.includes('instaops_posts') || !serialized.includes('instaops_media_assets')) {
      errors.push('W01: Must write primary records to Supabase instaops_posts and instaops_media_assets.');
    }
    if (!allCode.includes('DRAFT')) {
      errors.push('W01: Must stop in DRAFT status after extraction.');
    }
  }

  if (role === 'W02') {
    if (!allCode.includes('INSTAOPS_V2_PUBLISH')) {
      errors.push('W02: Missing INSTAOPS_V2_PUBLISH safeguard marker.');
    }
    if (hasSheetsNode(wf)) {
      errors.push('W02: Must not contain competing direct Google Sheets nodes (outbox sync belongs strictly to W04).');
    }
    if (!allCode.includes('LIVE_PUBLISH_ENABLED')) {
      errors.push('W02: Must enforce LIVE_PUBLISH_ENABLED inside W02 itself.');
    }
    if (!allCode.includes('approved_revision') || !allCode.includes('reviewed_revision') || !allCode.includes('reqRev !== currentRev || approvedRev !== currentRev')) {
      errors.push('W02: Must verify both reviewed_revision and approved_revision equal DB revision using logical OR rejection.');
    }
    if (!serialized.includes('instaops_transfer_or_claim_lock') || !serialized.includes('instaops_renew_lock') || !serialized.includes('instaops_release_lock')) {
      errors.push('W02: Must use atomic lock transfer, lease renewal, and ownership-checked release.');
    }
    if (!serialized.includes('/media_publish') || !serialized.includes('status_code')) {
      errors.push('W02: Must use explicit Meta Graph API container creation, status_code polling, and media_publish.');
    }
    if (!serialized.includes('is_carousel_item') || !serialized.includes('CAROUSEL') || !allCode.includes('ig_child_container_id')) {
      errors.push('W02: Must support complete 2-10 Carousel Graph API child & parent containers with persisted container IDs.');
    }
    if (!allCode.includes('VERIFY_MANUALLY') || !allCode.includes('PUBLISH_OUTCOME_UNKNOWN')) {
      errors.push('W02: Must persist uncertain outcomes as VERIFY_MANUALLY + PUBLISH_OUTCOME_UNKNOWN while preserving lock.');
    }
    if (serialized.includes('@mookielianhd/n8n-nodes-instagram')) {
      errors.push('W02: Must not use @mookielianhd/n8n-nodes-instagram opaque community node.');
    }
  }

  if (role === 'W03') {
    if (!allCode.includes('INSTAOPS_V2_SCHEDULE')) {
      errors.push('W03: Missing INSTAOPS_V2_SCHEDULE safeguard marker.');
    }
    const sched = wf.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    if (!sched || sched.disabled !== true) {
      errors.push('W03: Schedule trigger must be disabled by default in exported JSON.');
    }
    if (!serialized.includes('instaops_claim_due_scheduled_posts') || !serialized.includes('instaops_posts')) {
      errors.push('W03: Scheduled runner must claim due rows atomically via instaops_claim_due_scheduled_posts.');
    }
    if (!allCode.includes('SCHEDULED') || !allCode.includes('LATER') || !allCode.includes('SCHEDULING_ENABLED') || !allCode.includes('LIVE_PUBLISH_ENABLED')) {
      errors.push('W03: Scheduled runner must filter strictly for SCHEDULED + LATER and enforce SCHEDULING_ENABLED + LIVE_PUBLISH_ENABLED.');
    }
  }

  if (role === 'W04') {
    if (!allCode.includes('INSTAOPS_V2_CONTENT')) {
      errors.push('W04: Missing INSTAOPS_V2_CONTENT safeguard marker.');
    }
    for (const op of ['LIST_POSTS', 'LIST_MEDIA', 'CREATE_POST', 'UPDATE_POST', 'SCHEDULE_POST', 'CANCEL_SCHEDULE', 'ARCHIVE_POST', 'SYNC_RECORD', 'DELETE_MEDIA', 'DELETE_POST']) {
      if (!allCode.includes(op)) errors.push(`W04: Missing required allowlisted operation ${op}.`);
    }
    if (!allCode.includes('LIVE_DELETE_ENABLED') || !serialized.includes('/destroy')) {
      errors.push('W04: Must enforce LIVE_DELETE_ENABLED and verified Cloudinary /destroy endpoint.');
    }
    for (const tab of ['Posts', 'MediaAssets', 'ExecutionLogs', 'Accounts']) {
      if (!serialized.includes(`"${tab}"`)) {
        errors.push(`W04: Missing Google Sheets reporting tab "${tab}".`);
      }
    }
    const sheetsReads = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.googleSheets' && n.parameters?.operation === 'read');
    if (!sheetsReads.length || sheetsReads.some((n) => n.alwaysOutputData !== true)) {
      errors.push('W04: Google Sheets read nodes must set alwaysOutputData: true so empty sheets do not halt execution.');
    }
  }

  if (role === 'W05') {
    if (!allCode.includes('INSTAOPS_V2_RECOVERY')) {
      errors.push('W05: Missing INSTAOPS_V2_RECOVERY safeguard marker.');
    }
    if (!allCode.includes('CHECK_CONNECTIONS') || !allCode.includes('VERIFY_PUBLICATION') || !allCode.includes('SAFE_RETRY')) {
      errors.push('W05: Must support CHECK_CONNECTIONS, VERIFY_PUBLICATION, and SAFE_RETRY recovery operations.');
    }
    if (!serialized.includes('instaops_verify_health_and_rpc') || !allCode.includes('n8nEnv')) {
      errors.push('W05: Must verify Supabase schema+RLS+RPC via instaops_verify_health_and_rpc and surface n8nEnv diagnostics.');
    }
    if (!serialized.includes('graph.facebook.com')) {
      errors.push('W05: VERIFY_PUBLICATION must verify against live Meta Graph API before marking PUBLISHED.');
    }
    const sheetsProbe = wf.nodes.find((n) => n.type === 'n8n-nodes-base.googleSheets' && n.parameters?.operation === 'read');
    if (!sheetsProbe || sheetsProbe.alwaysOutputData !== true) {
      errors.push('W05: SHEETS probe node must set alwaysOutputData: true for empty worksheet safety.');
    }
  }

  return {
    name: wf.name,
    nodeCount: wf.nodes.length,
    valid: errors.length === 0,
    errors,
  };
}

export function assertVerifiedWorkflowExport(
  role: 'W01' | 'W02' | 'W03' | 'W04' | 'W05',
  wf: WorkflowJson,
): void {
  const res = verifyWorkflowExport(role, wf);
  if (!res.valid) {
    throw new AppError('CONFIGURATION_ERROR', `Workflow ${role} verification failed: ${res.errors.join('; ')}`, {
      httpStatus: 500,
    });
  }
}
