import { AppError } from '../errors/codes';

export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  disabled?: boolean;
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
  /Bearer\s+(?!\{\{|\$env)[A-Za-z0-9._-]{16,}/i,
  /x-dashboard-secret[^\n]*!==\s*["'][A-Za-z0-9._-]{12,}["']/i,
  /\bEAA[A-Za-z0-9]{20,}\b/,
];

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
        new Function('$', '$input', '$execution', '$env', js);
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

export function verifyWorkflowExport(
  role: 'W01' | 'W02' | 'W03' | 'W04' | 'W05',
  wf: WorkflowJson,
): WorkflowVerificationResult {
  const errors: string[] = [];
  validateGraphBasics(wf, role, errors);
  const allCode = combinedCode(wf);
  const serialized = JSON.stringify(wf);

  if (role === 'W01') {
    if (!allCode.includes('INSTAOPS_V2_EXTRACT')) {
      errors.push('W01: Missing INSTAOPS_V2_EXTRACT safeguard marker.');
    }
    if (/media_publish|INSTAGRAM\s*\|/i.test(serialized)) {
      errors.push('W01: Extraction workflow must never contain Instagram publishing nodes.');
    }
    if (!serialized.includes('/api/n8n/resolve')) {
      errors.push('W01: Must integrate with hosted downloader /api/n8n/resolve endpoint.');
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
    if (!allCode.includes('approved_revision') || !allCode.includes('revision')) {
      errors.push('W02: Must verify approved_revision === revision before publishing.');
    }
    if (!serialized.includes('/media_publish') || !serialized.includes('status_code')) {
      errors.push('W02: Must use explicit Meta Graph API container creation, status_code polling, and media_publish.');
    }
    if (!serialized.includes('is_carousel_item') || !serialized.includes('CAROUSEL')) {
      errors.push('W02: Must support complete multi-item Carousel Graph API child & parent containers.');
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
    if (!serialized.includes('instaops_posts')) {
      errors.push('W03: Scheduled runner must read authoritative due queue from Supabase instaops_posts.');
    }
    if (!allCode.includes('SCHEDULED') || !allCode.includes('LATER')) {
      errors.push('W03: Scheduled runner must filter strictly for SCHEDULED + LATER due posts.');
    }
  }

  if (role === 'W04') {
    if (!allCode.includes('INSTAOPS_V2_CONTENT')) {
      errors.push('W04: Missing INSTAOPS_V2_CONTENT safeguard marker.');
    }
    for (const op of ['LIST_POSTS', 'CREATE_POST', 'SYNC_RECORD', 'DELETE_MEDIA', 'DELETE_POST', 'ARCHIVE_POST']) {
      if (!allCode.includes(op)) errors.push(`W04: Missing required allowlisted operation ${op}.`);
    }
    if (!serialized.includes('/destroy')) {
      errors.push('W04: Missing Cloudinary destroy endpoint for asset deletion.');
    }
  }

  if (role === 'W05') {
    if (!allCode.includes('INSTAOPS_V2_RECOVERY')) {
      errors.push('W05: Missing INSTAOPS_V2_RECOVERY safeguard marker.');
    }
    if (!allCode.includes('CHECK_CONNECTIONS') || !allCode.includes('VERIFY_PUBLICATION')) {
      errors.push('W05: Must support CHECK_CONNECTIONS and VERIFY_PUBLICATION recovery operations.');
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
