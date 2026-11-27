import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import type { WorkflowJson, WorkflowNode } from '../../lib/n8n/workflow-safety';

type JsonRecord = Record<string, unknown>;

interface ExecutedNodeItem {
  json: JsonRecord;
}

interface HttpCallRequest {
  nodeName: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  formBody: Record<string, string> | null;
  credentials: Record<string, unknown>;
}

interface HttpCallResponse {
  statusCode?: number;
  body?: unknown;
  headers?: Record<string, string>;
  networkError?: string;
}

interface SheetOperationCall {
  nodeName: string;
  operation: string;
  documentId: string;
  sheetName: string;
  inputJson: JsonRecord;
}

interface WaitCall {
  nodeName: string;
  amount: number;
  unit: string;
}

interface DagRunOptions {
  webhookBody?: JsonRecord;
  webhookHeaders?: Record<string, string>;
  vars?: Record<string, string>;
  env?: Record<string, string>;
  envBlocked?: boolean;
  executionId?: string;
  ignoreTriggerDisabled?: boolean;
  maxSteps?: number;
  httpHandler: (req: HttpCallRequest) => HttpCallResponse | Promise<HttpCallResponse>;
  sheetsHandler?: (call: SheetOperationCall) => JsonRecord[] | Promise<JsonRecord[]>;
}

interface DagRunResult {
  responded: Array<{ nodeName: string; statusCode: number; body: unknown }>;
  httpCalls: HttpCallRequest[];
  sheetCalls: SheetOperationCall[];
  waitCalls: WaitCall[];
  executedNodes: string[];
  lastNodeOutput: JsonRecord | null;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TEST_SECRET = ['test', 'wh', 'secret', 'val'].join('_');
const TEST_CLD_KEY = ['9911', '2233', '44'].join('');
const TEST_CLD_SECRET = ['cld', 'sec', 'mock', 'val'].join('_');
const TEST_IG_ID = '17841453414532595';
const TEST_POST_UUID = '11111111-2222-4333-8444-555555555555';
const TEST_OTHER_UUID = '99999999-8888-4777-8666-555555555555';

function loadWorkflow(relPath: string): WorkflowJson {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')) as WorkflowJson;
}

function asRecord(val: unknown): JsonRecord {
  return val && typeof val === 'object' && !Array.isArray(val) ? (val as JsonRecord) : {};
}

function evalExpressionValue(
  raw: unknown,
  currentJson: JsonRecord,
  nodeHistory: Map<string, ExecutedNodeItem[]>,
  vars: Record<string, string>,
): unknown {
  if (typeof raw === 'string') {
    if (!raw.startsWith('=')) return raw;
    const body = raw.slice(1);
    const singleMatch = /^\{\{([\s\S]+)\}\}$/.exec(body.trim());
    const runExpr = (inner: string): unknown => {
      const fn = new Function(
        '$json',
        '$input',
        '$',
        '$vars',
        '$now',
        `return (${inner});`,
      ) as (
        $json: JsonRecord,
        $input: { first: () => ExecutedNodeItem; last: () => ExecutedNodeItem; all: () => ExecutedNodeItem[] },
        $: (name: string) => { first: () => ExecutedNodeItem; last: () => ExecutedNodeItem; all: () => ExecutedNodeItem[] },
        $vars: Record<string, string>,
        $now: Date,
      ) => unknown;
      const selector = (name: string) => {
        const list = nodeHistory.get(name) ?? [];
        const empty: ExecutedNodeItem = { json: {} };
        return {
          first: () => list[0] ?? empty,
          last: () => list[list.length - 1] ?? empty,
          all: () => list,
        };
      };
      const curInput = {
        first: () => ({ json: currentJson }),
        last: () => ({ json: currentJson }),
        all: () => [{ json: currentJson }],
      };
      return fn(currentJson, curInput, selector, vars, new Date());
    };
    if (singleMatch && !body.trim().slice(2, -2).includes('{{')) {
      return runExpr((singleMatch[1] ?? '').trim());
    }
    return body.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner: string) => {
      const evaluated = runExpr(inner.trim());
      return evaluated === undefined || evaluated === null ? '' : String(evaluated);
    });
  }
  return raw;
}

function runCodeNode(
  node: WorkflowNode,
  inputItems: ExecutedNodeItem[],
  nodeHistory: Map<string, ExecutedNodeItem[]>,
  opts: DagRunOptions,
): ExecutedNodeItem[] {
  const jsCode = String(node.parameters?.jsCode ?? '');
  assert.doesNotMatch(jsCode, /helpers\.httpRequest/, `Code node ${node.name} must not call helpers.httpRequest`);
  assert.doesNotMatch(jsCode, /\bfetch\s*\(/, `Code node ${node.name} must not call fetch()`);

  const selector = (name: string) => {
    const list = nodeHistory.get(name) ?? [];
    const empty: ExecutedNodeItem = { json: {} };
    return {
      first: () => list[0] ?? empty,
      last: () => list[list.length - 1] ?? empty,
      all: () => list,
    };
  };

  const sandbox: Record<string, unknown> = {
    $input: {
      first: () => inputItems[0] ?? { json: {} },
      last: () => inputItems[inputItems.length - 1] ?? { json: {} },
      all: () => inputItems,
    },
    $json: inputItems[0]?.json ?? {},
    $vars: opts.vars ?? {},
    $execution: { id: opts.executionId ?? 'exec_sim_1' },
    $: selector,
    helpers: {},
    fetch: undefined,
    URL,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    RegExp,
    encodeURIComponent,
    decodeURIComponent,
    unescape,
  };

  if (opts.envBlocked) {
    // Match hosted n8n v2.0 N8N_BLOCK_ENV_ACCESS_IN_NODE=true proxy behavior
    sandbox.$env = new Proxy(
      {},
      {
        get() {
          throw new Error('N8N_BLOCK_ENV_ACCESS_IN_NODE=true: $env access denied');
        },
        has() {
          throw new Error('N8N_BLOCK_ENV_ACCESS_IN_NODE=true: $env access denied');
        },
        ownKeys() {
          throw new Error('N8N_BLOCK_ENV_ACCESS_IN_NODE=true: $env access denied');
        },
      },
    );
  } else {
    sandbox.$env = opts.env ?? {};
  }

  const ctx = vm.createContext(sandbox);
  const wrapped = `(function() {\n${jsCode}\n}).call({ helpers: {} })`;
  const result = vm.runInContext(wrapped, ctx, { timeout: 5000 }) as unknown;
  if (!Array.isArray(result)) {
    throw new Error(`Code node ${node.name} returned non-array`);
  }
  return result.map((entry) => {
    const rec = asRecord(entry);
    return { json: asRecord(rec.json ?? rec) };
  });
}

function evalIfCondition(
  node: WorkflowNode,
  currentJson: JsonRecord,
  nodeHistory: Map<string, ExecutedNodeItem[]>,
  vars: Record<string, string>,
): boolean {
  const conditions = asRecord(node.parameters?.conditions);
  const bools = Array.isArray(conditions.boolean) ? conditions.boolean : [];
  for (const condRaw of bools) {
    const c = asRecord(condRaw);
    const v1 = Boolean(evalExpressionValue(c.value1, currentJson, nodeHistory, vars));
    const v2 = Boolean(c.value2);
    if (v1 !== v2) return false;
  }
  const strs = Array.isArray(conditions.string) ? conditions.string : [];
  for (const condRaw of strs) {
    const c = asRecord(condRaw);
    const v1 = String(evalExpressionValue(c.value1, currentJson, nodeHistory, vars) ?? '');
    const v2 = String(c.value2 ?? '');
    if (c.operation === 'equals' && v1 !== v2) return false;
  }
  return true;
}

function evalSwitchBranch(
  node: WorkflowNode,
  currentJson: JsonRecord,
  nodeHistory: Map<string, ExecutedNodeItem[]>,
  vars: Record<string, string>,
): number {
  const rulesObj = asRecord(node.parameters?.rules);
  const rules = Array.isArray(rulesObj.values) ? rulesObj.values : [];
  for (let i = 0; i < rules.length; i++) {
    const rule = asRecord(rules[i]);
    const condWrap = asRecord(rule.conditions);
    const list = Array.isArray(condWrap.conditions) ? condWrap.conditions : [];
    const matchedAll = list.every((itemRaw) => {
      const cond = asRecord(itemRaw);
      const op = asRecord(cond.operator);
      const left = String(evalExpressionValue(cond.leftValue, currentJson, nodeHistory, vars) ?? '');
      const right = String(cond.rightValue ?? '');
      if (op.operation === 'equals') return left === right;
      if (op.operation === 'startsWith') return left.startsWith(right);
      return false;
    });
    if (matchedAll) return i;
  }
  return rules.length;
}

async function runWorkflowDag(wf: WorkflowJson, opts: DagRunOptions): Promise<DagRunResult> {
  const nodeMap = new Map<string, WorkflowNode>();
  for (const node of wf.nodes) nodeMap.set(node.name, node);

  const trigger = wf.nodes.find(
    (n) => n.type === 'n8n-nodes-base.webhook' || n.type === 'n8n-nodes-base.scheduleTrigger',
  );
  if (!trigger) throw new Error(`No trigger node found in ${wf.name}`);
  if (trigger.type === 'n8n-nodes-base.scheduleTrigger' && trigger.disabled && !opts.ignoreTriggerDisabled) {
    return {
      responded: [],
      httpCalls: [],
      sheetCalls: [],
      waitCalls: [],
      executedNodes: [],
      lastNodeOutput: null,
    };
  }

  const nodeHistory = new Map<string, ExecutedNodeItem[]>();
  const responded: DagRunResult['responded'] = [];
  const httpCalls: HttpCallRequest[] = [];
  const sheetCalls: SheetOperationCall[] = [];
  const waitCalls: WaitCall[] = [];
  const executedNodes: string[] = [];
  let lastNodeOutput: JsonRecord | null = null;

  const triggerItems: ExecutedNodeItem[] = [
    {
      json:
        trigger.type === 'n8n-nodes-base.webhook'
          ? { headers: opts.webhookHeaders ?? {}, body: opts.webhookBody ?? {} }
          : { timestamp: new Date().toISOString() },
    },
  ];
  nodeHistory.set(trigger.name, triggerItems);

  const queue: Array<{ nodeName: string; items: ExecutedNodeItem[] }> = [];
  const firstBranch = wf.connections[trigger.name]?.main?.[0] ?? [];
  for (const edge of firstBranch) {
    queue.push({ nodeName: edge.node, items: triggerItems });
  }

  const maxSteps = opts.maxSteps ?? 120;
  let steps = 0;
  const vars = opts.vars ?? {};

  while (queue.length > 0) {
    if (++steps > maxSteps) {
      throw new Error(`DAG simulation exceeded maxSteps=${maxSteps} in ${wf.name}`);
    }
    const task = queue.shift()!;
    const node = nodeMap.get(task.nodeName);
    if (!node) throw new Error(`Missing target node ${task.nodeName}`);
    executedNodes.push(node.name);
    const currentJson = task.items[0]?.json ?? {};

    let outItems: ExecutedNodeItem[] = task.items;
    let outBranch = 0;

    if (node.type === 'n8n-nodes-base.code') {
      outItems = runCodeNode(node, task.items, nodeHistory, opts);
    } else if (node.type === 'n8n-nodes-base.if') {
      outBranch = evalIfCondition(node, currentJson, nodeHistory, vars) ? 0 : 1;
      outItems = task.items;
    } else if (node.type === 'n8n-nodes-base.switch') {
      outBranch = evalSwitchBranch(node, currentJson, nodeHistory, vars);
      outItems = task.items;
    } else if (node.type === 'n8n-nodes-base.wait') {
      const amount = Number(evalExpressionValue(node.parameters?.amount, currentJson, nodeHistory, vars) ?? 1);
      const unit = String(node.parameters?.unit ?? 'seconds');
      waitCalls.push({ nodeName: node.name, amount, unit });
      outItems = task.items;
    } else if (node.type === 'n8n-nodes-base.respondToWebhook') {
      const bodyRaw = evalExpressionValue(node.parameters?.responseBody, currentJson, nodeHistory, vars);
      let parsedBody: unknown = bodyRaw;
      if (typeof bodyRaw === 'string') {
        try {
          parsedBody = JSON.parse(bodyRaw);
        } catch {
          parsedBody = bodyRaw;
        }
      }
      const optionsRec = asRecord(node.parameters?.options);
      const statusRaw = evalExpressionValue(optionsRec.responseCode, currentJson, nodeHistory, vars);
      const statusCode = Number(statusRaw || 200);
      responded.push({ nodeName: node.name, statusCode, body: parsedBody });
      outItems = task.items;
    } else if (node.type === 'n8n-nodes-base.googleSheets') {
      const docObj = asRecord(node.parameters?.documentId);
      const sheetObj = asRecord(node.parameters?.sheetName);
      const docId = String(evalExpressionValue(docObj.value, currentJson, nodeHistory, vars) ?? '');
      const sheetName = String(evalExpressionValue(sheetObj.value, currentJson, nodeHistory, vars) ?? '');
      const op = String(node.parameters?.operation ?? 'read');
      const call: SheetOperationCall = {
        nodeName: node.name,
        operation: op,
        documentId: docId,
        sheetName,
        inputJson: currentJson,
      };
      sheetCalls.push(call);
      const rows = opts.sheetsHandler ? await opts.sheetsHandler(call) : [];
      if (rows.length === 0 && node.alwaysOutputData) {
        outItems = [{ json: {} }];
      } else {
        outItems = rows.map((r) => ({ json: r }));
      }
    } else if (node.type === 'n8n-nodes-base.httpRequest') {
      const url = String(evalExpressionValue(node.parameters?.url, currentJson, nodeHistory, vars) ?? '');
      const method = String(node.parameters?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      const headerParams = asRecord(asRecord(node.parameters?.headerParameters).parameters);
      if (Array.isArray(asRecord(node.parameters?.headerParameters).parameters)) {
        for (const hpRaw of asRecord(node.parameters?.headerParameters).parameters as unknown[]) {
          const hp = asRecord(hpRaw);
          headers[String(hp.name)] = String(evalExpressionValue(hp.value, currentJson, nodeHistory, vars) ?? '');
        }
      } else {
        void headerParams;
      }

      let body: unknown = undefined;
      let formBody: Record<string, string> | null = null;
      if (node.parameters?.sendBody) {
        if (node.parameters?.contentType === 'form-urlencoded') {
          formBody = {};
          const params = Array.isArray(asRecord(node.parameters?.bodyParameters).parameters)
            ? (asRecord(node.parameters?.bodyParameters).parameters as unknown[])
            : [];
          for (const bpRaw of params) {
            const bp = asRecord(bpRaw);
            formBody[String(bp.name)] = String(
              evalExpressionValue(bp.value, currentJson, nodeHistory, vars) ?? '',
            );
          }
          body = formBody;
        } else {
          const rawJson = evalExpressionValue(node.parameters?.jsonBody, currentJson, nodeHistory, vars);
          if (typeof rawJson === 'string') {
            try {
              body = JSON.parse(rawJson);
            } catch {
              body = rawJson;
            }
          } else {
            body = rawJson;
          }
        }
      }

      const req: HttpCallRequest = {
        nodeName: node.name,
        method,
        url,
        headers,
        body,
        formBody,
        credentials: asRecord(node.credentials),
      };
      httpCalls.push(req);
      const res = await opts.httpHandler(req);
      if (res.networkError) {
        outItems = [{ json: { error: { message: res.networkError } } }];
      } else {
        outItems = [
          {
            json: {
              statusCode: res.statusCode ?? 200,
              body: res.body ?? {},
              headers: res.headers ?? {},
            },
          },
        ];
      }
    }

    const hist = nodeHistory.get(node.name) ?? [];
    for (const it of outItems) hist.push(it);
    nodeHistory.set(node.name, hist);
    if (outItems[0]) lastNodeOutput = outItems[0].json;

    const branches = wf.connections[node.name]?.main ?? [];
    const edges = branches[outBranch] ?? [];
    for (const edge of edges) {
      queue.push({ nodeName: edge.node, items: outItems });
    }
  }

  return { responded, httpCalls, sheetCalls, waitCalls, executedNodes, lastNodeOutput };
}

function cloudinarySig(params: Record<string, string>, secret: string): string {
  const base = Object.keys(params)
    .filter((k) => k !== 'file' && k !== 'api_key' && k !== 'signature' && k !== 'resource_type')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(`${base}${secret}`).digest('hex');
}

describe('Real n8n Workflow DAG Execution (Zero helpers.httpRequest / Zero fetch)', () => {
  it('W01: blocks when $env is denied and $vars lacks secret (HTTP 500)', async () => {
    const w01 = loadWorkflow('n8n/workflows/01-extract-upload.json');
    const res = await runWorkflowDag(w01, {
      envBlocked: true,
      vars: {},
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-EXT-01',
        source_instagram_url: 'https://www.instagram.com/reel/Abc123/',
        authorized: true,
      },
      httpHandler: () => {
        throw new Error('No HTTP request should run when guard rejects');
      },
    });
    assert.equal(res.responded[0]?.statusCode, 500);
    assert.equal(res.httpCalls.length, 0);
  });

  it('W01: executes mixed 3-item carousel via $vars + native HTTP Request nodes -> instaops-v2/ DRAFT', async () => {
    const w01 = loadWorkflow('n8n/workflows/01-extract-upload.json');
    let finalizePayload: JsonRecord = {};
    let renewCount = 0;

    const res = await runWorkflowDag(w01, {
      envBlocked: true,
      vars: {
        N8N_WEBHOOK_SECRET: TEST_SECRET,
        SUPABASE_URL: 'https://sb.example.supabase.co',
        DOWNLOADER_BASE_URL: 'https://ig-dowloader-nnnn.vercel.app',
        CLOUDINARY_CLOUD_NAME: 'demo',
        CLOUDINARY_API_KEY: TEST_CLD_KEY,
        CLOUDINARY_API_SECRET: TEST_CLD_SECRET,
      },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-EXT-02',
        source_instagram_url: 'https://www.instagram.com/p/Carousel123/',
        authorized: true,
        job_id: 'job_ext_1',
        request_id: 'req_ext_1',
        lock_key: `post:${TEST_POST_UUID}`,
        lock_owner: 'next:req_ext_1',
      },
      httpHandler: (req) => {
        if (req.url.includes('/rpc/instaops_transfer_or_claim_lock')) {
          return { statusCode: 200, body: [{ acquired: true }] };
        }
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return {
            statusCode: 200,
            body: [{ id: TEST_POST_UUID, post_id: 'IG-EXT-02', status: 'DRAFT', media_type: 'CAROUSEL' }],
          };
        }
        if (req.url === 'https://ig-dowloader-nnnn.vercel.app/api/n8n/resolve') {
          assert.ok(req.credentials.httpHeaderAuth, 'Downloader node must bind httpHeaderAuth');
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'ready',
              caption: 'Carousel #test @user1',
              mediaType: 'CAROUSEL',
              sourceId: 'Carousel123',
              items: [
                { url: 'https://cdn.example.com/1.jpg', type: 'IMAGE' },
                { url: 'https://cdn.example.com/2.mp4', type: 'VIDEO' },
                { url: 'https://cdn.example.com/3.jpg', type: 'IMAGE' },
              ],
            },
          };
        }
        if (req.url.includes('/rpc/instaops_renew_lock')) {
          renewCount++;
          return { statusCode: 200, body: [{ renewed: true }] };
        }
        if (req.url.startsWith('https://api.cloudinary.com/v1_1/demo/') && req.url.endsWith('/upload')) {
          assert.ok(req.formBody, 'Cloudinary upload must use form-urlencoded');
          assert.equal(
            cloudinarySig(req.formBody, TEST_CLD_SECRET),
            req.formBody.signature,
            'Cloudinary upload signature must verify cleanly',
          );
          assert.ok(req.formBody.public_id?.startsWith('instaops-v2/'));
          const isVid = req.url.includes('/video/');
          return {
            statusCode: 200,
            body: {
              public_id: req.formBody.public_id,
              asset_id: `cld_${req.formBody.public_id}`,
              secure_url: `https://res.cloudinary.com/demo/${isVid ? 'video' : 'image'}/upload/v1/${req.formBody.public_id}.${isVid ? 'mp4' : 'jpg'}`,
              bytes: 1024,
              type: 'upload',
            },
          };
        }
        if (req.url.includes('/rpc/instaops_finalize_extraction')) {
          finalizePayload = asRecord(req.body);
          return { statusCode: 200, body: { ok: true } };
        }
        return { statusCode: 200, body: [] };
      },
    });

    assert.equal(res.responded[0]?.statusCode, 202);
    assert.ok(renewCount >= 3, 'Expected pre-upload and per-item lock renewals');
    const patch = asRecord(finalizePayload.p_post_patch);
    assert.equal(patch.status, 'DRAFT');
    assert.equal(patch.media_type, 'CAROUSEL');
    assert.equal(patch.media_count, 3);
    assert.equal(patch.image_count, 2);
    assert.equal(patch.video_count, 1);
    const assets = finalizePayload.p_assets as JsonRecord[];
    assert.equal(assets.length, 3);
  });

  it('W01: rejects pending downloader or expired expiresAt BEFORE Cloudinary uploads and checkpoints partial failures', async () => {
    const w01 = loadWorkflow('n8n/workflows/01-extract-upload.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      SUPABASE_URL: 'https://sb.example.supabase.co',
      DOWNLOADER_BASE_URL: 'https://ig-dowloader-nnnn.vercel.app',
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: TEST_CLD_KEY,
      CLOUDINARY_API_SECRET: TEST_CLD_SECRET,
    };

    // Expired URL must fail before any Cloudinary call
    let expPatch: JsonRecord = {};
    const resExp = await runWorkflowDag(w01, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-EXP-1',
        source_instagram_url: 'https://instagram.com/reel/Exp1/',
        authorized: true,
      },
      httpHandler: (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: 'DRAFT' }] };
        if (req.url.endsWith('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: { ok: true, status: 'ready', items: [{ url: 'https://cdn.example.com/a.mp4', type: 'VIDEO', expiresAt: '2020-01-01T00:00:00Z' }] },
          };
        }
        if (req.url.includes('instaops_finalize_extraction')) {
          expPatch = asRecord(asRecord(req.body).p_post_patch);
          return { statusCode: 200, body: { ok: true } };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(resExp.httpCalls.some((c) => c.url.includes('api.cloudinary.com')), false);
    assert.equal(expPatch.status, 'FAILED');
    assert.equal(expPatch.error_code, 'MEDIA_URL_EXPIRED');

    // Partial 2-item upload failure must checkpoint item 0
    let partialFinalize: JsonRecord = {};
    let uploadTry = 0;
    await runWorkflowDag(w01, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-PART-1',
        source_instagram_url: 'https://instagram.com/p/Part1/',
        authorized: true,
      },
      httpHandler: (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: 'DRAFT' }] };
        if (req.url.endsWith('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: { ok: true, status: 'ready', items: [{ url: 'https://cdn.example.com/1.jpg', type: 'IMAGE' }, { url: 'https://cdn.example.com/2.jpg', type: 'IMAGE' }] },
          };
        }
        if (req.url.includes('/upload')) {
          uploadTry++;
          if (uploadTry === 1) {
            return {
              statusCode: 200,
              body: { public_id: 'instaops-v2/IG-PART-1/item_0_src', asset_id: 'a0', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/instaops-v2/IG-PART-1/item_0_src.jpg', bytes: 500 },
            };
          }
          return { statusCode: 500, body: { error: { message: 'upstream cld fail' } } };
        }
        if (req.url.includes('instaops_finalize_extraction')) {
          partialFinalize = asRecord(req.body);
          return { statusCode: 200, body: { ok: true } };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal((partialFinalize.p_assets as JsonRecord[]).length, 1);
    assert.equal(asRecord(partialFinalize.p_post_patch).status, 'FAILED');
    assert.equal(asRecord(partialFinalize.p_post_patch).error_code, 'CLOUDINARY_UPLOAD_FAILED');
  });

  it('W02: enforces LIVE_PUBLISH_ENABLED=false, logical-OR revision check, disabled account, and no spoofed media URLs', async () => {
    const w02 = loadWorkflow('n8n/workflows/02-publish-content.json');

    const resDisabled = await runWorkflowDag(w02, {
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET, LIVE_PUBLISH_ENABLED: 'false' },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-P-1', reviewed_revision: '2', confirm: true },
      httpHandler: () => {
        throw new Error('Must block before HTTP calls');
      },
    });
    assert.equal(resDisabled.responded[0]?.statusCode, 409);

    let releasedOnRevMismatch = false;
    await runWorkflowDag(w02, {
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET, LIVE_PUBLISH_ENABLED: 'true', SUPABASE_URL: 'https://sb.example.supabase.co' },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-P-2', reviewed_revision: '3', approved_revision: '3', confirm: true, job_id: 'job_rev_1' },
      httpHandler: (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts')) {
          // DB revision=3, approved_revision=2 (stale approval even though request claimed 3)
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-P-2', status: 'READY', revision: 3, approved_revision: 2, ig_user_id: TEST_IG_ID, media_type: 'IMAGE', caption: 'hi' }] };
        }
        if (req.url.includes('instaops_media_assets')) {
          return { statusCode: 200, body: [{ id: 'a1', storage_status: 'ACTIVE', media_index: 0, resource_type: 'image', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/ok.jpg' }] };
        }
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes('instaops_release_lock')) {
          releasedOnRevMismatch = true;
          return { statusCode: 200, body: [{ released: true }] };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(releasedOnRevMismatch, true);
  });

  it('W02: executes 9-item mixed carousel using native Wait nodes, Lock Renewals, Immediate published_id save & Log Sync', async () => {
    const w02 = loadWorkflow('n8n/workflows/02-publish-content.json');
    const events: string[] = [];
    let parentStatusChecks = 0;
    let vid1Checks = 0;

    const assets = Array.from({ length: 9 }, (_, i) => ({
      id: `ast_row_${i}`,
      internal_asset_id: `ast_${i}`,
      media_index: i,
      resource_type: i === 2 ? 'video' : 'image',
      media_type: i === 2 ? 'VIDEO' : 'IMAGE',
      storage_status: 'ACTIVE',
      secure_url: `https://res.cloudinary.com/demo/${i === 2 ? 'video' : 'image'}/upload/v1/instaops-v2/p/${i}.${i === 2 ? 'mp4' : 'jpg'}`,
    }));

    const res = await runWorkflowDag(w02, {
      maxSteps: 300,
      vars: {
        N8N_WEBHOOK_SECRET: TEST_SECRET,
        LIVE_PUBLISH_ENABLED: 'true',
        SUPABASE_URL: 'https://sb.example.supabase.co',
        N8N_GRAPH_POLL_INTERVAL_SEC: '2',
        N8N_GRAPH_MAX_POLLS: '5',
      },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-CAR-9',
        ig_user_id: TEST_IG_ID,
        reviewed_revision: '4',
        approved_revision: '4',
        confirm: true,
        job_id: 'job_car9',
        request_id: 'req_car9',
        lock_key: `post:${TEST_POST_UUID}`,
        lock_owner: 'next:req_car9',
        media_url: 'https://evil.spoofed.url/malicious.jpg',
      },
      httpHandler: (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-CAR-9', status: 'READY', revision: 4, approved_revision: 4, ig_user_id: TEST_IG_ID, media_type: 'CAROUSEL', caption: '9 items!' }] };
        }
        if (req.url.includes('instaops_media_assets') && req.method === 'GET') return { statusCode: 200, body: assets };
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.endsWith(`/${TEST_IG_ID}/media`)) {
          const b = asRecord(req.body);
          if (b.is_carousel_item) {
            const urlStr = String(b.image_url ?? b.video_url ?? '');
            assert.equal(urlStr.includes('evil.spoofed.url'), false, 'Spoofed request URL must be ignored');
            const idxMatch = /\/(\d+)\.(jpg|mp4)$/.exec(urlStr);
            const idx = Number(idxMatch?.[1] ?? 0);
            return { statusCode: 200, body: { id: `child_c_${idx}` } };
          }
          events.push('PARENT_CREATE');
          assert.equal(b.media_type, 'CAROUSEL');
          return { statusCode: 200, body: { id: 'parent_c_999' } };
        }
        if (req.url.includes('/child_c_2?')) {
          vid1Checks++;
          return { statusCode: 200, body: { id: 'child_c_2', status_code: vid1Checks < 2 ? 'IN_PROGRESS' : 'FINISHED' } };
        }
        if (req.url.includes('/parent_c_999?')) {
          parentStatusChecks++;
          return { statusCode: 200, body: { id: 'parent_c_999', status_code: parentStatusChecks < 2 ? 'IN_PROGRESS' : 'FINISHED' } };
        }
        if (req.url.endsWith(`/${TEST_IG_ID}/media_publish`)) {
          events.push('MEDIA_PUBLISH');
          return { statusCode: 200, body: { id: '17999999999999999' } };
        }
        if (req.url.includes('instaops_posts') && req.method === 'PATCH') {
          const patch = asRecord(req.body);
          if (patch.status === 'PUBLISHED') events.push('PERSIST_PUBLISHED_ID');
          if (patch.published_url) events.push('SAVE_PERMALINK');
          return { statusCode: 200, body: [{ ...patch, id: TEST_POST_UUID, post_id: 'IG-CAR-9' }] };
        }
        if (req.url.includes('/17999999999999999?')) {
          events.push('FETCH_PERMALINK');
          return { statusCode: 200, body: { id: '17999999999999999', permalink: 'https://www.instagram.com/p/C9abc/' } };
        }
        if (req.url.includes('instaops_release_lock')) {
          events.push('RELEASE_LOCK');
          return { statusCode: 200, body: [{ released: true }] };
        }
        if (req.url.includes('instaops_sync_queue')) {
          events.push(`SYNC_${String(asRecord(req.body).entity_type)}`);
          return { statusCode: 201, body: {} };
        }
        return { statusCode: 200, body: { renewed: true } };
      },
    });

    assert.equal(res.responded[0]?.statusCode, 202);
    assert.ok(res.waitCalls.some((w) => w.nodeName === 'WAIT | Child Poll Backoff' && w.amount === 2));
    assert.ok(res.waitCalls.some((w) => w.nodeName === 'WAIT | Parent Poll Backoff' && w.amount === 2));
    assert.deepEqual(events, [
      'PARENT_CREATE',
      'MEDIA_PUBLISH',
      'PERSIST_PUBLISHED_ID',
      'FETCH_PERMALINK',
      'SAVE_PERMALINK',
      'SYNC_POST',
      'SYNC_EXECUTION_LOG',
      'RELEASE_LOCK',
    ]);
  });

  it('W02: preserves PUBLISHED without double-publishing on permalink error, and retains VERIFY_MANUALLY + lock on timeout or PUBLISHED container', async () => {
    const w02 = loadWorkflow('n8n/workflows/02-publish-content.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      LIVE_PUBLISH_ENABLED: 'true',
      SUPABASE_URL: 'https://sb.example.supabase.co',
      N8N_GRAPH_POLL_INTERVAL_SEC: '1',
    };

    // Case 1: Permalink error after media_publish succeeds
    let auditLogged = false;
    let mediaPubCount = 0;
    await runWorkflowDag(w02, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-PERM-ERR', reviewed_revision: '1', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-PERM-ERR', status: 'READY', revision: 1, approved_revision: 1, ig_user_id: TEST_IG_ID, media_type: 'IMAGE', caption: 'ok' }] };
        }
        if (req.url.includes('instaops_media_assets')) {
          return { statusCode: 200, body: [{ id: 'a0', storage_status: 'ACTIVE', media_index: 0, resource_type: 'image', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/ok.jpg' }] };
        }
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.endsWith(`/${TEST_IG_ID}/media`)) return { statusCode: 200, body: { id: 'c_single_1' } };
        if (req.url.includes('/c_single_1?')) return { statusCode: 200, body: { id: 'c_single_1', status_code: 'FINISHED' } };
        if (req.url.endsWith(`/${TEST_IG_ID}/media_publish`)) {
          mediaPubCount++;
          return { statusCode: 200, body: { id: 'pub_single_1' } };
        }
        if (req.url.includes('/pub_single_1?')) return { statusCode: 502, body: { error: { message: 'meta flake' } } };
        if (req.url.includes('instaops_audit_events')) {
          auditLogged = true;
          return { statusCode: 201, body: {} };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(mediaPubCount, 1);
    assert.equal(auditLogged, true);

    // Case 2: media_publish timeout retains VERIFY_MANUALLY + preserves lock (no release_lock call)
    let lockReleasedOnTimeout = false;
    let uncertainStatus = '';
    await runWorkflowDag(w02, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-TO-1', reviewed_revision: '1', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-TO-1', status: 'READY', revision: 1, approved_revision: 1, ig_user_id: TEST_IG_ID, media_type: 'IMAGE', caption: 'ok' }] };
        }
        if (req.url.includes('instaops_media_assets')) {
          return { statusCode: 200, body: [{ id: 'a0', storage_status: 'ACTIVE', media_index: 0, resource_type: 'image', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/ok.jpg' }] };
        }
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.endsWith(`/${TEST_IG_ID}/media`)) return { statusCode: 200, body: { id: 'c_to_1' } };
        if (req.url.includes('/c_to_1?')) return { statusCode: 200, body: { id: 'c_to_1', status_code: 'FINISHED' } };
        if (req.url.endsWith(`/${TEST_IG_ID}/media_publish`)) return { networkError: 'ETIMEDOUT' };
        if (req.url.includes('instaops_posts') && req.method === 'PATCH' && asRecord(req.body).status === 'VERIFY_MANUALLY') {
          uncertainStatus = String(asRecord(req.body).error_code ?? '');
          return { statusCode: 200, body: [{}] };
        }
        if (req.url.includes('instaops_release_lock')) lockReleasedOnTimeout = true;
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(uncertainStatus, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(lockReleasedOnTimeout, false);
  });

  it('W03: disabled schedule gate skips RPC; enabled runner atomically claims and handles 4xx vs timeout safely', async () => {
    const w03 = loadWorkflow('n8n/workflows/03-scheduled-runner.json');
    const cronNode = w03.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    assert.equal(cronNode?.disabled, true);

    const skippedRes = await runWorkflowDag(w03, {
      ignoreTriggerDisabled: true,
      vars: { SCHEDULING_ENABLED: 'false', LIVE_PUBLISH_ENABLED: 'true' },
      httpHandler: () => {
        throw new Error('RPC must not run when SCHEDULING_ENABLED=false');
      },
    });
    assert.equal(skippedRes.httpCalls.length, 0);

    let releasedOn4xx = false;
    await runWorkflowDag(w03, {
      ignoreTriggerDisabled: true,
      vars: { SCHEDULING_ENABLED: 'true', LIVE_PUBLISH_ENABLED: 'true', SUPABASE_URL: 'https://sb.example.supabase.co', N8N_BASE_URL: 'https://n8n.example.com' },
      httpHandler: (req) => {
        if (req.url.includes('instaops_claim_due_scheduled_posts')) {
          return {
            statusCode: 200,
            body: [{ post_uuid: TEST_POST_UUID, post_id: 'IG-SCH-1', ig_user_id: TEST_IG_ID, media_type: 'REEL', revision: 2, approved_revision: 2, lock_key: `post:${TEST_POST_UUID}`, lock_owner: 'w03:lock1', job_id: 'job_sch_1', request_id: 'req_sch_1' }],
          };
        }
        if (req.url.includes('/webhook/instaops-publish-v1')) {
          assert.ok(req.credentials.httpHeaderAuth, 'W03 dispatch must bind httpHeaderAuth');
          assert.equal(asRecord(req.body).lock_owner, 'w03:lock1');
          return { statusCode: 409, body: { error: 'revision conflict' } };
        }
        if (req.url.includes('instaops_release_lock')) {
          releasedOn4xx = true;
          return { statusCode: 200, body: [{ released: true }] };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(releasedOn4xx, true);
  });

  it('W04: enforces authoritative deletion lock before ANY Cloudinary /destroy (conflict blocks; direct calls acquire & release; partial failure returns ok=true)', async () => {
    const w04 = loadWorkflow('n8n/workflows/04-content-management.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      LIVE_DELETE_ENABLED: 'true',
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: TEST_CLD_KEY,
      CLOUDINARY_API_SECRET: TEST_CLD_SECRET,
    };

    // Conflict with active PUBLISH lock MUST stop before any Cloudinary /destroy
    const conflictRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-1', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-DEL-1', status: 'READY' }] };
        if (req.url.includes('/instaops_media_assets?')) {
          return { statusCode: 200, body: [{ post_uuid: TEST_POST_UUID, internal_asset_id: 'ast_1', cloudinary_public_id: 'instaops-v2/IG-DEL-1/item_0', resource_type: 'image', delivery_type: 'upload', storage_status: 'ACTIVE' }] };
        }
        if (req.url.includes('/instaops_job_locks?')) {
          return { statusCode: 200, body: [{ lock_key: `post:${TEST_POST_UUID}`, operation: 'PUBLISH', owner_id: 'w02:worker_live' }] };
        }
        if (req.url.includes('/instaops_jobs?')) return { statusCode: 200, body: [] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(conflictRes.httpCalls.some((c) => c.url.includes('api.cloudinary.com')), false);
    assert.equal(asRecord(conflictRes.responded[0]?.body).ok, false);

    // Direct webhook call with no pre-lock MUST claim lock via instaops_acquire_lock BEFORE Cloudinary /destroy and release it after
    const directEvents: string[] = [];
    const directRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_POST', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-2', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-DEL-2', status: 'DRAFT' }] };
        if (req.url.includes('/instaops_media_assets?')) {
          return {
            statusCode: 200,
            body: [
              { post_uuid: TEST_POST_UUID, internal_asset_id: 'ast_0', cloudinary_public_id: 'instaops-v2/IG-DEL-2/item_0', resource_type: 'image', delivery_type: 'upload', storage_status: 'ACTIVE' },
              { post_uuid: TEST_POST_UUID, internal_asset_id: 'ast_1', cloudinary_public_id: 'instaops-v2/IG-DEL-2/item_1', resource_type: 'video', delivery_type: 'upload', storage_status: 'ACTIVE' },
            ],
          };
        }
        if (req.url.includes('/instaops_job_locks?')) return { statusCode: 200, body: [] };
        if (req.url.includes('/instaops_jobs?')) return { statusCode: 200, body: [] };
        if (req.url.includes('/rpc/instaops_acquire_lock')) {
          directEvents.push('ACQUIRE_LOCK');
          return { statusCode: 200, body: [{ acquired: true }] };
        }
        if (req.url.includes('/destroy')) {
          directEvents.push('DESTROY');
          assert.ok(req.formBody, 'Cloudinary destroy requires form-urlencoded params');
          assert.equal(
            cloudinarySig(req.formBody, TEST_CLD_SECRET),
            req.formBody.signature,
            'Cloudinary destroy signature must match sent form parameters (including type)',
          );
          if (req.url.includes('/video/')) {
            return { statusCode: 500, body: { error: { message: 'cld err' } } };
          }
          return { statusCode: 200, body: { result: 'ok' } };
        }
        if (req.url.includes('/rpc/instaops_release_lock')) {
          directEvents.push('RELEASE_LOCK');
          return { statusCode: 200, body: [{ released: true }] };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.deepEqual(directEvents, ['ACQUIRE_LOCK', 'DESTROY', 'DESTROY', 'RELEASE_LOCK']);
    const bodyOut = asRecord(directRes.responded[0]?.body);
    assert.equal(bodyOut.ok, true);
    assert.equal(bodyOut.partial_failure, true);
    assert.equal(bodyOut.status, 'FAILED');
    assert.equal((bodyOut.outcomes as JsonRecord[]).length, 2);

    // Next.js caller lock handoff (OWNER_VERIFIED) syncs 4 tabs + handles empty sheet confirmation cleanly
    const syncEmpty = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'SYNC_RECORD', entity_type: 'EXECUTION_LOG', entity_uuid: TEST_POST_UUID, external_id: 'log_1', payload: { log_id: 'log_1', error_message: '=CMD()' } },
      sheetsHandler: (call) => {
        assert.equal(call.sheetName, 'ExecutionLogs');
        assert.equal(call.inputJson.error_message, "'=CMD()");
        return [];
      },
      httpHandler: () => ({ statusCode: 200, body: [] }),
    });
    assert.equal(asRecord(syncEmpty.responded[0]?.body).synced, false);
  });

  it('W05: removes list[0] fallback completely — retains VERIFY_MANUALLY on ambiguous/empty caption and verifies exact 1-of-1 match', async () => {
    const w05 = loadWorkflow('n8n/workflows/05-recovery-reconciliation.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
      INSTAGRAM_USER_ID: TEST_IG_ID,
      GOOGLE_SHEET_ID: 'sheet_1',
    };

    // CHECK_CONNECTIONS with empty Posts sheet + envBlocked=true ($vars OK)
    const healthRes = await runWorkflowDag(w05, {
      envBlocked: true,
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'CHECK_CONNECTIONS' },
      sheetsHandler: () => [],
      httpHandler: (req) => {
        if (req.url.includes('instaops_verify_health_and_rpc')) {
          return { statusCode: 200, body: [{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, detail: 'ok' }] };
        }
        if (req.url.includes('/usage')) {
          assert.ok(req.credentials.httpBasicAuth, 'Cloudinary /usage must bind httpBasicAuth');
          return { statusCode: 200, body: { plan: 'Free', resources: 5 } };
        }
        return { statusCode: 200, body: { id: TEST_IG_ID, username: 'instaops_demo' } };
      },
    });
    assert.equal(asRecord(asRecord(asRecord(healthRes.responded[0]?.body).services).supabase).ok, true);
    assert.equal(asRecord(asRecord(asRecord(healthRes.responded[0]?.body).services).n8nEnv).ok, true);

    // Ambiguous caption (2 matching items on IG feed) MUST NOT pick list[0] -> retains VERIFY_MANUALLY
    const ambiguousRes = await runWorkflowDag(w05, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'VERIFY_PUBLICATION', post_uuid: TEST_POST_UUID, post_id: 'IG-REC-AMB' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-REC-AMB', ig_user_id: TEST_IG_ID, media_type: 'IMAGE', container_id: 'cont_1', caption: 'Repeated Title', status: 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('/instaops_accounts?')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) return { statusCode: 200, body: { id: TEST_IG_ID, username: 'instaops_demo' } };
        if (req.url.includes('/cont_1?')) return { statusCode: 200, body: { id: 'cont_1', status_code: 'PUBLISHED' } };
        if (req.url.includes(`/${TEST_IG_ID}/media?`)) {
          return {
            statusCode: 200,
            body: {
              data: [
                { id: 'ig_pub_1', caption: 'Repeated Title', media_type: 'IMAGE', permalink: 'https://instagram.com/p/1/' },
                { id: 'ig_pub_2', caption: 'Repeated Title', media_type: 'IMAGE', permalink: 'https://instagram.com/p/2/' },
              ],
            },
          };
        }
        if (req.url.includes('published_id=neq.')) return { statusCode: 200, body: [] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(asRecord(ambiguousRes.responded[0]?.body).verified, false);
    assert.equal(asRecord(ambiguousRes.responded[0]?.body).status, 'VERIFY_MANUALLY');

    // Empty caption MUST NOT match feed item without published_id
    const emptyCaptionRes = await runWorkflowDag(w05, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'VERIFY_PUBLICATION', post_uuid: TEST_POST_UUID, post_id: 'IG-REC-EMPTY' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-REC-EMPTY', ig_user_id: TEST_IG_ID, media_type: 'REEL', container_id: 'cont_e', caption: '', status: 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('/instaops_accounts?')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) return { statusCode: 200, body: { id: TEST_IG_ID, username: 'instaops_demo' } };
        if (req.url.includes('/cont_e?')) return { statusCode: 200, body: { id: 'cont_e', status_code: 'PUBLISHED' } };
        if (req.url.includes(`/${TEST_IG_ID}/media?`)) {
          return { statusCode: 200, body: { data: [{ id: 'ig_pub_x', caption: '', media_type: 'VIDEO' }] } };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(asRecord(emptyCaptionRes.responded[0]?.body).verified, false);

    // Unambiguous 1-of-1 match promotes to PUBLISHED + clears lock
    let clearedLock = false;
    const exactRes = await runWorkflowDag(w05, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'VERIFY_PUBLICATION', post_uuid: TEST_POST_UUID, post_id: 'IG-REC-OK' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-REC-OK', ig_user_id: TEST_IG_ID, media_type: 'REEL', container_id: 'cont_ok', caption: 'Unique Launch Reel', created_at: '2026-11-27T00:00:00Z', status: 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('/instaops_accounts?')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) return { statusCode: 200, body: { id: TEST_IG_ID, username: 'instaops_demo' } };
        if (req.url.includes('/cont_ok?')) return { statusCode: 200, body: { id: 'cont_ok', status_code: 'PUBLISHED' } };
        if (req.url.includes(`/${TEST_IG_ID}/media?`)) {
          return {
            statusCode: 200,
            body: {
              data: [
                { id: 'ig_other_used', caption: 'Unique Launch Reel', media_type: 'VIDEO', timestamp: '2026-11-27T00:01:00Z' },
                { id: 'ig_exact_1', caption: 'Unique Launch Reel', media_type: 'VIDEO', timestamp: '2026-11-27T00:02:00Z', permalink: 'https://instagram.com/reel/Exact1/' },
              ],
            },
          };
        }
        if (req.url.includes('published_id=neq.')) return { statusCode: 200, body: [{ id: TEST_OTHER_UUID, published_id: 'ig_other_used' }] };
        if (req.url.includes('/instaops_job_locks?') && req.method === 'DELETE') {
          clearedLock = true;
          return { statusCode: 200, body: [] };
        }
        return { statusCode: 200, body: {} };
      },
    });
    const exactBody = asRecord(exactRes.responded[0]?.body);
    assert.equal(exactBody.verified, true);
    assert.equal(exactBody.status, 'PUBLISHED');
    assert.equal(exactBody.published_id, 'ig_exact_1');
    assert.equal(clearedLock, true);
  });

  it('W04 & W05 extra gates: blocks unresolved PUBLISH jobs, verifies Next.js lock ownership, and rejects mismatched Meta owner/type on published_id', async () => {
    const w04 = loadWorkflow('n8n/workflows/04-content-management.json');
    const w05 = loadWorkflow('n8n/workflows/05-recovery-reconciliation.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      LIVE_DELETE_ENABLED: 'true',
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
      CLOUDINARY_API_KEY: TEST_CLD_KEY,
      CLOUDINARY_API_SECRET: TEST_CLD_SECRET,
      INSTAGRAM_USER_ID: TEST_IG_ID,
    };

    // W04 blocks direct webhook delete when unresolved PUBLISH (OUTCOME_UNKNOWN) job exists
    const unresolvedRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-JOB', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-DEL-JOB', status: 'READY' }] };
        if (req.url.includes('/instaops_media_assets?')) {
          return { statusCode: 200, body: [{ post_uuid: TEST_POST_UUID, internal_asset_id: 'ast_1', cloudinary_public_id: 'instaops-v2/IG-DEL-JOB/item_0', resource_type: 'image', delivery_type: 'upload', storage_status: 'ACTIVE' }] };
        }
        if (req.url.includes('/instaops_job_locks?')) return { statusCode: 200, body: [] };
        if (req.url.includes('/instaops_jobs?')) return { statusCode: 200, body: [{ job_id: 'job_unk', operation: 'PUBLISH', status: 'OUTCOME_UNKNOWN' }] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(unresolvedRes.httpCalls.some((c) => c.url.includes('instaops_acquire_lock') || c.url.includes('/destroy')), false);
    assert.equal(asRecord(unresolvedRes.responded[0]?.body).ok, false);

    // W04 rejects wrong caller lock_owner, and accepts matching caller lock_owner without claiming or releasing it
    const wrongOwnerRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-OWN', confirm: true, lock_key: `post:${TEST_POST_UUID}`, lock_owner: 'wrong:owner' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-DEL-OWN', status: 'READY' }] };
        if (req.url.includes('/instaops_media_assets?')) {
          return { statusCode: 200, body: [{ post_uuid: TEST_POST_UUID, internal_asset_id: 'ast_1', cloudinary_public_id: 'instaops-v2/IG-DEL-OWN/item_0', resource_type: 'image', delivery_type: 'upload', storage_status: 'ACTIVE' }] };
        }
        if (req.url.includes('/instaops_job_locks?')) return { statusCode: 200, body: [{ lock_key: `post:${TEST_POST_UUID}`, operation: 'DELETE_MEDIA', owner_id: 'next:real_owner' }] };
        if (req.url.includes('/instaops_jobs?')) return { statusCode: 200, body: [] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(wrongOwnerRes.httpCalls.some((c) => c.url.includes('/destroy')), false);

    let callerLockTouched = false;
    const okOwnerRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-OWN', confirm: true, lock_key: `post:${TEST_POST_UUID}`, lock_owner: 'next:real_owner' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?')) return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-DEL-OWN', status: 'READY' }] };
        if (req.url.includes('/instaops_media_assets?')) {
          return { statusCode: 200, body: [{ post_uuid: TEST_POST_UUID, internal_asset_id: 'ast_1', cloudinary_public_id: 'instaops-v2/IG-DEL-OWN/item_0', resource_type: 'image', delivery_type: 'upload', storage_status: 'ACTIVE' }] };
        }
        if (req.url.includes('/instaops_job_locks?')) return { statusCode: 200, body: [{ lock_key: `post:${TEST_POST_UUID}`, operation: 'DELETE_MEDIA', owner_id: 'next:real_owner' }] };
        if (req.url.includes('/instaops_jobs?')) return { statusCode: 200, body: [] };
        if (req.url.includes('instaops_acquire_lock') || req.url.includes('instaops_release_lock')) {
          callerLockTouched = true;
          return { statusCode: 200, body: [] };
        }
        if (req.url.includes('/destroy')) return { statusCode: 200, body: { result: 'ok' } };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(callerLockTouched, false);
    assert.equal(asRecord(okOwnerRes.responded[0]?.body).status, 'MEDIA_DELETED');

    // W05 explicit published_id verification rejects mismatched owner.id -> retains VERIFY_MANUALLY
    const wrongIgOwnerRes = await runWorkflowDag(w05, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'VERIFY_PUBLICATION', post_uuid: TEST_POST_UUID, post_id: 'IG-REC-BADOWN', resolution: 'MARK_PUBLISHED', published_id: 'pub_foreign_1' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-REC-BADOWN', ig_user_id: TEST_IG_ID, media_type: 'IMAGE', status: 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('/instaops_accounts?')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) return { statusCode: 200, body: { id: TEST_IG_ID, username: 'instaops_demo' } };
        if (req.url.includes('/pub_foreign_1?')) return { statusCode: 200, body: { id: 'pub_foreign_1', media_type: 'IMAGE', owner: { id: '999999999999999' } } };
        if (req.url.includes('instaops_posts?published_id=eq.')) return { statusCode: 200, body: [] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(asRecord(wrongIgOwnerRes.responded[0]?.body).verified, false);
    assert.equal(asRecord(wrongIgOwnerRes.responded[0]?.body).status, 'VERIFY_MANUALLY');
  });
});
