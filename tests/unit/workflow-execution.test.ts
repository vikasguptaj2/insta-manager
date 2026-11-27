import assert from 'node:assert/strict';
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
  expectedWebhookSecret?: string;
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
const TEST_IG_ID = '17841453414532595';
const TEST_POST_UUID = '11111111-2222-4333-8444-555555555555';

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

function evalV2Condition(
  cond: JsonRecord,
  currentJson: JsonRecord,
  nodeHistory: Map<string, ExecutedNodeItem[]>,
  vars: Record<string, string>,
): boolean {
  const op = asRecord(cond.operator);
  const opType = String(op.type || '').toLowerCase();
  const opName = String(op.operation || '');
  const leftVal = evalExpressionValue(cond.leftValue, currentJson, nodeHistory, vars);
  const rightVal = evalExpressionValue(cond.rightValue, currentJson, nodeHistory, vars);

  if (opType === 'boolean') {
    if (opName === 'true') return Boolean(leftVal) === true;
    if (opName === 'false') return Boolean(leftVal) === false;
    if (opName === 'equals') return Boolean(leftVal) === Boolean(rightVal);
    if (opName === 'notEquals') return Boolean(leftVal) !== Boolean(rightVal);
    if (opName === 'exists') return leftVal !== undefined && leftVal !== null;
    if (opName === 'notExists') return leftVal === undefined || leftVal === null;
  }
  if (opType === 'number') {
    const l = Number(leftVal);
    const r = Number(rightVal);
    if (opName === 'equals') return l === r;
    if (opName === 'notEquals') return l !== r;
    if (opName === 'gt') return l > r;
    if (opName === 'gte') return l >= r;
    if (opName === 'lt') return l < r;
    if (opName === 'lte') return l <= r;
  }
  const ls = leftVal === undefined || leftVal === null ? '' : String(leftVal);
  const rs = rightVal === undefined || rightVal === null ? '' : String(rightVal);
  if (opName === 'equals') return ls === rs;
  if (opName === 'notEquals') return ls !== rs;
  if (opName === 'startsWith') return ls.startsWith(rs);
  if (opName === 'endsWith') return ls.endsWith(rs);
  if (opName === 'contains') return ls.includes(rs);
  if (opName === 'notEmpty') return ls.length > 0;
  if (opName === 'empty') return ls.length === 0;
  if (opName === 'exists') return leftVal !== undefined && leftVal !== null;
  if (opName === 'notExists') return leftVal === undefined || leftVal === null;
  return false;
}

function evalIfCondition(
  node: WorkflowNode,
  currentJson: JsonRecord,
  nodeHistory: Map<string, ExecutedNodeItem[]>,
  vars: Record<string, string>,
): boolean {
  const conditions = asRecord(node.parameters?.conditions);
  if (Array.isArray(conditions.conditions)) {
    const list = conditions.conditions as unknown[];
    const combinator = String(conditions.combinator || 'and').toLowerCase();
    if (list.length === 0) return true;
    return combinator === 'or'
      ? list.some((c) => evalV2Condition(asRecord(c), currentJson, nodeHistory, vars))
      : list.every((c) => evalV2Condition(asRecord(c), currentJson, nodeHistory, vars));
  }
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
    const combinator = String(condWrap.combinator || 'and').toLowerCase();
    const matched =
      combinator === 'or'
        ? list.some((itemRaw) => evalV2Condition(asRecord(itemRaw), currentJson, nodeHistory, vars))
        : list.every((itemRaw) => evalV2Condition(asRecord(itemRaw), currentJson, nodeHistory, vars));
    if (matched) return i;
  }
  return rules.length;
}

async function runWorkflowDag(wf: WorkflowJson, opts: DagRunOptions): Promise<DagRunResult> {
  const nodeMap = new Map<string, WorkflowNode>();
  for (const node of wf.nodes) nodeMap.set(node.name, node);

  const trigger = wf.nodes.find(
    (n) =>
      n.type === 'n8n-nodes-base.webhook' ||
      n.type === 'n8n-nodes-base.scheduleTrigger' ||
      n.type === 'n8n-nodes-base.manualTrigger',
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
  if (trigger.type === 'n8n-nodes-base.webhook' && trigger.parameters?.authentication === 'headerAuth') {
    const hdrCred = asRecord(asRecord(trigger.credentials).httpHeaderAuth);
    assert.ok(hdrCred.id || hdrCred.name, `Webhook ${trigger.name} must bind httpHeaderAuth credential`);
    const headers = opts.webhookHeaders ?? {};
    const received = Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-dashboard-secret')?.[1] ?? '';
    const expected = opts.expectedWebhookSecret ?? opts.vars?.N8N_WEBHOOK_SECRET ?? TEST_SECRET;
    if (!expected || received !== expected) {
      return {
        responded: [
          {
            nodeName: trigger.name,
            statusCode: 403,
            body: { code: 403, message: 'Authorization data is wrong!' },
          },
        ],
        httpCalls: [],
        sheetCalls: [],
        waitCalls: [],
        executedNodes: [],
        lastNodeOutput: null,
      };
    }
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

describe('Real n8n Workflow DAG Execution (Zero helpers.httpRequest / Zero fetch)', () => {
  it('W00: executes 5-provider manual credential diagnostic (including httpBasicAuth Cloudinary & httpHeaderAuth Meta/Downloader)', async () => {
    const w00 = loadWorkflow('n8n/workflows/00-manual-credential-check.json');
    const res = await runWorkflowDag(w00, {
      httpHandler: (req) => {
        if (req.url.includes('/rest/v1/instaops_posts')) {
          assert.ok(req.credentials.httpCustomAuth, 'W00 Supabase check requires httpCustomAuth');
          return { statusCode: 200, body: [{ id: TEST_POST_UUID }] };
        }
        if (req.url.endsWith('/api/n8n/resolve')) {
          assert.ok(req.credentials.httpHeaderAuth, 'W00 Downloader check requires httpHeaderAuth');
          return { statusCode: 400, body: { ok: false, error: 'Missing url' } };
        }
        if (req.url.includes('/usage')) {
          assert.ok(req.credentials.httpBasicAuth, 'W00 Cloudinary check requires httpBasicAuth');
          return { statusCode: 200, body: { plan: 'Free', resources: 4 } };
        }
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) {
          assert.ok(req.credentials.httpHeaderAuth, 'W00 IG check requires httpHeaderAuth');
          return { statusCode: 200, body: { id: TEST_IG_ID, username: 'vikas.sphere' } };
        }
        return { statusCode: 200, body: {} };
      },
      sheetsHandler: () => [],
    });

    assert.equal(asRecord(asRecord(res.lastNodeOutput).supabase).ok, true);
    assert.equal(asRecord(asRecord(res.lastNodeOutput).downloader).ok, true);
    assert.equal(asRecord(asRecord(res.lastNodeOutput).cloudinary).ok, true);
    assert.equal(asRecord(asRecord(res.lastNodeOutput).instagram).username, 'vikas.sphere');
    assert.equal(asRecord(asRecord(res.lastNodeOutput).sheets).ok, true);
  });

  it('W01: native Webhook Header Auth rejects missing/wrong secret and validates authorized flag BEFORE HTTP calls', async () => {
    const w01 = loadWorkflow('n8n/workflows/01-extract-upload.json');
    const unauth = await runWorkflowDag(w01, {
      envBlocked: true,
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET },
      webhookHeaders: { 'x-dashboard-secret': 'wrong_secret' },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-EXT-01',
        source_instagram_url: 'https://www.instagram.com/reel/Abc123/',
        authorized: true,
      },
      httpHandler: () => {
        throw new Error('No HTTP request should run when Header Auth rejects');
      },
    });
    assert.equal(unauth.responded[0]?.statusCode, 403);
    assert.equal(unauth.executedNodes.length, 0);
    assert.equal(unauth.httpCalls.length, 0);

    const noConsent = await runWorkflowDag(w01, {
      envBlocked: true,
      vars: {},
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: {
        post_uuid: TEST_POST_UUID,
        post_id: 'IG-EXT-01B',
        source_instagram_url: 'https://www.instagram.com/reel/Abc123/',
        authorized: false,
      },
      httpHandler: () => {
        throw new Error('No HTTP request should run when authorized !== true');
      },
    });
    assert.equal(noConsent.responded[0]?.statusCode, 403);
    assert.equal(noConsent.httpCalls.length, 0);
  });

  it('W01: executes mixed 3-item carousel via $vars + Basic Auth Cloudinary + CHECK guards -> instaops-v2/ DRAFT', async () => {
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
        if (req.url.includes('/instaops_posts?id=eq.') && req.method === 'GET') {
          return {
            statusCode: 200,
            body: [
              {
                id: TEST_POST_UUID,
                post_id: 'IG-EXT-02',
                source_instagram_url: 'https://www.instagram.com/p/Carousel123/',
                revision: 1,
                status: 'DRAFT',
                media_type: 'CAROUSEL',
              },
            ],
          };
        }
        if (req.url.includes('/instaops_posts?id=eq.') && req.method === 'PATCH') {
          return {
            statusCode: 200,
            body: [{ id: TEST_POST_UUID, status: asRecord(req.body).status || 'UPLOADING' }],
          };
        }
        if (req.url.includes('/instaops_jobs?job_id=eq.') && req.method === 'PATCH') {
          return { statusCode: 200, body: [{ job_id: 'job_ext_1' }] };
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
                { url: 'https://scontent.cdninstagram.com/v/1.jpg', type: 'IMAGE' },
                { url: 'https://scontent.cdninstagram.com/v/2.mp4', type: 'VIDEO' },
                { url: 'https://scontent.cdninstagram.com/v/3.jpg', type: 'IMAGE' },
              ],
            },
          };
        }
        if (req.url.includes('/rpc/instaops_renew_lock')) {
          renewCount++;
          return { statusCode: 200, body: [{ renewed: true }] };
        }
        if (req.url.startsWith('https://api.cloudinary.com/v1_1/demo/') && req.url.endsWith('/upload')) {
          assert.ok(req.credentials.httpBasicAuth, 'Cloudinary upload must bind httpBasicAuth');
          assert.ok(req.formBody, 'Cloudinary upload must use form-urlencoded');
          assert.ok(req.formBody.public_id?.startsWith('instaops-v2/'));
          const isVid = req.url.includes('/video/');
          return {
            statusCode: 200,
            body: {
              public_id: req.formBody.public_id,
              asset_id: `cld_${req.formBody.public_id}`,
              secure_url: `https://res.cloudinary.com/demo/${isVid ? 'video' : 'image'}/upload/v1/${req.formBody.public_id}.${isVid ? 'mp4' : 'jpg'}`,
              resource_type: isVid ? 'video' : 'image',
              bytes: 1024,
              type: 'upload',
            },
          };
        }
        if (req.url.includes('/rpc/instaops_finalize_extraction')) {
          finalizePayload = asRecord(req.body);
          return {
            statusCode: 200,
            body: [{ id: TEST_POST_UUID, status: asRecord(finalizePayload.p_post_patch).status || 'DRAFT' }],
          };
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
    };

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
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return {
            statusCode: 200,
            body: [
              {
                id: TEST_POST_UUID,
                post_id: 'IG-EXP-1',
                source_instagram_url: 'https://instagram.com/reel/Exp1/',
                revision: 1,
                status: 'DRAFT',
              },
            ],
          };
        }
        if (req.url.includes('instaops_posts') && req.method === 'PATCH') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: 'EXTRACTING' }] };
        }
        if (req.url.endsWith('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'ready',
              items: [{ url: 'https://scontent.cdninstagram.com/v/a.mp4', type: 'VIDEO', expiresAt: '2020-01-01T00:00:00Z' }],
            },
          };
        }
        if (req.url.includes('instaops_finalize_extraction')) {
          expPatch = asRecord(asRecord(req.body).p_post_patch);
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: String(expPatch.status || 'FAILED') }] };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(resExp.httpCalls.some((c) => c.url.includes('api.cloudinary.com')), false);
    assert.equal(expPatch.status, 'FAILED');
    assert.equal(expPatch.error_code, 'MEDIA_URL_EXPIRED');

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
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return {
            statusCode: 200,
            body: [
              {
                id: TEST_POST_UUID,
                post_id: 'IG-PART-1',
                source_instagram_url: 'https://instagram.com/p/Part1/',
                revision: 1,
                status: 'DRAFT',
              },
            ],
          };
        }
        if (req.url.includes('instaops_posts') && req.method === 'PATCH') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: 'UPLOADING' }] };
        }
        if (req.url.includes('instaops_renew_lock')) return { statusCode: 200, body: [{ renewed: true }] };
        if (req.url.endsWith('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'ready',
              items: [
                { url: 'https://scontent.cdninstagram.com/v/1.jpg', type: 'IMAGE' },
                { url: 'https://scontent.cdninstagram.com/v/2.jpg', type: 'IMAGE' },
              ],
            },
          };
        }
        if (req.url.includes('/upload')) {
          uploadTry++;
          if (uploadTry === 1) {
            return {
              statusCode: 200,
              body: {
                public_id: `instaops-v2/${TEST_POST_UUID}/item_0_src`,
                asset_id: 'a0',
                secure_url: `https://res.cloudinary.com/demo/image/upload/v1/instaops-v2/${TEST_POST_UUID}/item_0_src.jpg`,
                resource_type: 'image',
                bytes: 500,
              },
            };
          }
          return { statusCode: 500, body: { error: { message: 'upstream cld fail' } } };
        }
        if (req.url.includes('instaops_finalize_extraction')) {
          partialFinalize = asRecord(req.body);
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: 'FAILED' }] };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal((partialFinalize.p_assets as JsonRecord[]).length, 1);
    assert.equal(asRecord(partialFinalize.p_post_patch).status, 'FAILED');
    assert.equal(asRecord(partialFinalize.p_post_patch).error_code, 'CLOUDINARY_UPLOAD_FAILED');
  });

  it('W02: enforces authoritative DB runtime gate (409 false / 503 RPC fail), revision check, disabled account, and no spoofed URLs', async () => {
    const w02 = loadWorkflow('n8n/workflows/02-publish-content.json');

    const resDisabled = await runWorkflowDag(w02, {
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET, SUPABASE_URL: 'https://sb.example.supabase.co' },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-P-1', reviewed_revision: '2', confirm: true, live_publish_enabled: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ live_publish_enabled: false, live_delete_enabled: false, scheduling_enabled: false }] };
        }
        throw new Error('Must block before lock or Graph calls when DB live_publish_enabled=false');
      },
    });
    assert.equal(resDisabled.responded[0]?.statusCode, 409);
    assert.equal(resDisabled.httpCalls.length, 1);

    const resRpcFail = await runWorkflowDag(w02, {
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET, SUPABASE_URL: 'https://sb.example.supabase.co' },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-P-1B', reviewed_revision: '2', confirm: true, live_publish_enabled: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 500, body: { message: 'rpc down' } };
        }
        throw new Error('Must fail closed (503) when settings RPC errors');
      },
    });
    assert.equal(resRpcFail.responded[0]?.statusCode, 503);

    let releasedOnRevMismatch = false;
    await runWorkflowDag(w02, {
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET, SUPABASE_URL: 'https://sb.example.supabase.co', CLOUDINARY_CLOUD_NAME: 'demo' },
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-P-2', reviewed_revision: '3', approved_revision: '3', confirm: true, job_id: 'job_rev_1' },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ live_publish_enabled: true, live_delete_enabled: false, scheduling_enabled: false }] };
        }
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts')) {
          return {
            statusCode: 200,
            body: [{ id: TEST_POST_UUID, post_id: 'IG-P-2', status: 'READY', revision: 3, approved_revision: 2, ig_user_id: TEST_IG_ID, media_type: 'IMAGE', media_count: 1, caption: 'hi' }],
          };
        }
        if (req.url.includes('instaops_media_assets')) {
          return {
            statusCode: 200,
            body: [{ id: 'a1', post_uuid: TEST_POST_UUID, storage_status: 'ACTIVE', media_index: 0, resource_type: 'image', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/ok.jpg' }],
          };
        }
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes('instaops_jobs?job_id=eq.') && req.method === 'PATCH') {
          return { statusCode: 200, body: [{ job_id: 'job_rev_1' }] };
        }
        if (req.url.includes('instaops_release_lock')) {
          releasedOnRevMismatch = true;
          return { statusCode: 200, body: [{ released: true }] };
        }
        return { statusCode: 200, body: [{}] };
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
      post_uuid: TEST_POST_UUID,
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
        SUPABASE_URL: 'https://sb.example.supabase.co',
        CLOUDINARY_CLOUD_NAME: 'demo',
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
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ live_publish_enabled: true, live_delete_enabled: false, scheduling_enabled: false }] };
        }
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-CAR-9', status: 'READY', revision: 4, approved_revision: 4, ig_user_id: TEST_IG_ID, media_type: 'CAROUSEL', media_count: 9, caption: '9 items!' }] };
        }
        if (req.url.includes('instaops_media_assets') && req.method === 'GET') return { statusCode: 200, body: assets };
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes('instaops_media_assets') && req.method === 'PATCH') return { statusCode: 200, body: [{}] };
        if (req.url.includes('instaops_jobs?job_id=eq.') && req.method === 'PATCH') return { statusCode: 200, body: [{ job_id: 'job_car9' }] };
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
          return {
            statusCode: 200,
            body: [{ ...patch, id: TEST_POST_UUID, post_id: 'IG-CAR-9', status: patch.status || 'PUBLISHED', published_id: '17999999999999999' }],
          };
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
        if (req.url.includes('instaops_renew_lock')) return { statusCode: 200, body: [{ renewed: true }] };
        return { statusCode: 200, body: [{}] };
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
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
      N8N_GRAPH_POLL_INTERVAL_SEC: '1',
    };

    let auditLogged = false;
    let mediaPubCount = 0;
    await runWorkflowDag(w02, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-PERM-ERR', reviewed_revision: '1', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_publish_enabled: true }] };
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-PERM-ERR', status: 'READY', revision: 1, approved_revision: 1, ig_user_id: TEST_IG_ID, media_type: 'IMAGE', media_count: 1, caption: 'ok' }] };
        }
        if (req.url.includes('instaops_media_assets')) {
          return { statusCode: 200, body: [{ id: 'a0', post_uuid: TEST_POST_UUID, storage_status: 'ACTIVE', media_index: 0, resource_type: 'image', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/ok.jpg' }] };
        }
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes('instaops_renew_lock')) return { statusCode: 200, body: [{ renewed: true }] };
        if (req.url.endsWith(`/${TEST_IG_ID}/media`)) return { statusCode: 200, body: { id: 'c_single_1' } };
        if (req.url.includes('/c_single_1?')) return { statusCode: 200, body: { id: 'c_single_1', status_code: 'FINISHED' } };
        if (req.url.endsWith(`/${TEST_IG_ID}/media_publish`)) {
          mediaPubCount++;
          return { statusCode: 200, body: { id: '18000000000000001' } };
        }
        if (req.url.includes('instaops_posts') && req.method === 'PATCH') {
          const patch = asRecord(req.body);
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: patch.status || 'PUBLISHED', published_id: patch.published_id || '18000000000000001' }] };
        }
        if (req.url.includes('/18000000000000001?')) return { statusCode: 502, body: { error: { message: 'meta flake' } } };
        if (req.url.includes('instaops_audit_events')) {
          auditLogged = true;
          return { statusCode: 201, body: {} };
        }
        if (req.url.includes('instaops_release_lock')) return { statusCode: 200, body: [{ released: true }] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(mediaPubCount, 1);
    assert.equal(auditLogged, true);

    let lockReleasedOnTimeout = false;
    let uncertainStatus = '';
    await runWorkflowDag(w02, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { post_uuid: TEST_POST_UUID, post_id: 'IG-TO-1', reviewed_revision: '1', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_publish_enabled: true }] };
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-TO-1', status: 'READY', revision: 1, approved_revision: 1, ig_user_id: TEST_IG_ID, media_type: 'IMAGE', media_count: 1, caption: 'ok' }] };
        }
        if (req.url.includes('instaops_media_assets')) {
          return { statusCode: 200, body: [{ id: 'a0', post_uuid: TEST_POST_UUID, storage_status: 'ACTIVE', media_index: 0, resource_type: 'image', secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/ok.jpg' }] };
        }
        if (req.url.includes('instaops_accounts')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes('instaops_renew_lock')) return { statusCode: 200, body: [{ renewed: true }] };
        if (req.url.endsWith(`/${TEST_IG_ID}/media`)) return { statusCode: 200, body: { id: 'c_to_1' } };
        if (req.url.includes('/c_to_1?')) return { statusCode: 200, body: { id: 'c_to_1', status_code: 'FINISHED' } };
        if (req.url.endsWith(`/${TEST_IG_ID}/media_publish`)) return { networkError: 'ETIMEDOUT' };
        if (req.url.includes('instaops_posts') && req.method === 'PATCH') {
          const patch = asRecord(req.body);
          if (patch.status === 'VERIFY_MANUALLY') uncertainStatus = String(patch.error_code ?? '');
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, status: patch.status || 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('instaops_release_lock')) lockReleasedOnTimeout = true;
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(uncertainStatus, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(lockReleasedOnTimeout, false);
  });

  it('W03: disabled DB schedule gate skips claim RPC; enabled runner atomically claims and handles 4xx vs timeout safely', async () => {
    const w03 = loadWorkflow('n8n/workflows/03-scheduled-runner.json');
    const cronNode = w03.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
    assert.equal(cronNode?.disabled, true);

    const skippedRes = await runWorkflowDag(w03, {
      ignoreTriggerDisabled: true,
      vars: { SUPABASE_URL: 'https://sb.example.supabase.co' },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ scheduling_enabled: false, live_publish_enabled: true }] };
        }
        throw new Error('Claim RPC must not run when DB scheduling_enabled=false');
      },
    });
    assert.equal(skippedRes.httpCalls.length, 1);

    let releasedOn4xx = false;
    await runWorkflowDag(w03, {
      ignoreTriggerDisabled: true,
      vars: { SUPABASE_URL: 'https://sb.example.supabase.co', N8N_BASE_URL: 'https://n8n.example.com' },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ scheduling_enabled: true, live_publish_enabled: true }] };
        }
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

  it('W04: enforces DB live_delete_enabled + deletion lock before Cloudinary /destroy; direct calls acquire, finalize RPC & release', async () => {
    const w04 = loadWorkflow('n8n/workflows/04-content-management.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
    };

    // Fail-closed 409 when DB live_delete_enabled=false even if request attempts spoof
    const blockedGateRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-GATE', confirm: true, live_delete_enabled: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ live_publish_enabled: false, live_delete_enabled: false, scheduling_enabled: false }] };
        }
        throw new Error('Must stop before post read or Cloudinary when DB live_delete_enabled=false');
      },
    });
    assert.equal(blockedGateRes.responded[0]?.statusCode, 409);

    // Conflict with active PUBLISH lock MUST stop before any Cloudinary /destroy
    const conflictRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-1', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_delete_enabled: true }] };
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

    // Direct webhook call MUST acquire lock BEFORE Cloudinary /destroy (Basic Auth), call instaops_finalize_deletion, and release lock
    const directEvents: string[] = [];
    const directRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_POST', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-2', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_delete_enabled: true }] };
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
          assert.ok(req.credentials.httpBasicAuth, 'Cloudinary destroy must bind httpBasicAuth');
          assert.ok(req.formBody, 'Cloudinary destroy sends form-urlencoded params');
          if (req.url.includes('/video/')) {
            return { statusCode: 500, body: { error: { message: 'cld err' } } };
          }
          return { statusCode: 200, body: { result: 'ok' } };
        }
        if (req.url.includes('/rpc/instaops_finalize_deletion')) {
          directEvents.push('FINALIZE_DELETION');
          return { statusCode: 200, body: [{ ok: true, status: 'FAILED' }] };
        }
        if (req.url.includes('/rpc/instaops_release_lock')) {
          directEvents.push('RELEASE_LOCK');
          return { statusCode: 200, body: [{ released: true }] };
        }
        return { statusCode: 200, body: [] };
      },
    });
    assert.deepEqual(directEvents, ['ACQUIRE_LOCK', 'DESTROY', 'DESTROY', 'FINALIZE_DELETION', 'RELEASE_LOCK']);
    const bodyOut = asRecord(directRes.responded[0]?.body);
    assert.equal(bodyOut.ok, true);
    assert.equal(bodyOut.partial_failure, true);
    assert.equal(bodyOut.status, 'FAILED');
    assert.equal((bodyOut.outcomes as JsonRecord[]).length, 2);

    const syncEmpty = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'SYNC_RECORD', entity_type: 'EXECUTION_LOG', entity_uuid: TEST_POST_UUID, external_id: 'log_1', payload: { log_id: 'log_1', error_message: '=CMD()' } },
      sheetsHandler: (call) => {
        assert.equal(call.sheetName, 'ExecutionLogs');
        assert.equal(call.inputJson.error_message, "'=CMD()");
        return [];
      },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_delete_enabled: false }] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(asRecord(syncEmpty.responded[0]?.body).synced, false);
  });

  it('W05: returns CHECK_CONNECTIONS runtime gates, never falls back to feed similarity, and verifies explicit MARK_PUBLISHED published_id', async () => {
    const w05 = loadWorkflow('n8n/workflows/05-recovery-reconciliation.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
      INSTAGRAM_USER_ID: TEST_IG_ID,
      GOOGLE_SHEET_ID: 'sheet_1',
    };

    const healthRes = await runWorkflowDag(w05, {
      envBlocked: true,
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'CHECK_CONNECTIONS', request_id: 'req_hc_1' },
      sheetsHandler: () => [],
      httpHandler: (req) => {
        if (req.url.includes('instaops_verify_health_and_rpc')) {
          return { statusCode: 200, body: [{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, detail: 'ok' }] };
        }
        if (req.url.includes('instaops_get_runtime_settings')) {
          return { statusCode: 200, body: [{ live_publish_enabled: false, live_delete_enabled: false, scheduling_enabled: false, updated_by: 'migration' }] };
        }
        if (req.url.includes('/usage')) {
          assert.ok(req.credentials.httpBasicAuth, 'Cloudinary /usage must bind httpBasicAuth');
          return { statusCode: 200, body: { plan: 'Free', resources: 5 } };
        }
        return { statusCode: 200, body: { id: TEST_IG_ID, username: 'vikas.sphere' } };
      },
    });
    const hcBody = asRecord(healthRes.responded[0]?.body);
    assert.equal(asRecord(asRecord(hcBody.services).supabase).ok, true);
    assert.equal(asRecord(asRecord(hcBody.services).n8nEnv).ok, true);
    assert.equal(asRecord(asRecord(hcBody.services).n8nEnv).settingsAvailable, true);
    assert.equal(asRecord(asRecord(hcBody.services).n8nEnv).livePublishEnabled, false);

    // Without persisted published_id, even exact caption match MUST retain VERIFY_MANUALLY (zero feed-similarity guessing)
    const noPersistedIdRes = await runWorkflowDag(w05, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'VERIFY_PUBLICATION', post_uuid: TEST_POST_UUID, post_id: 'IG-REC-NOPUB' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-REC-NOPUB', ig_user_id: TEST_IG_ID, media_type: 'REEL', container_id: 'cont_ok', caption: 'Unique Launch Reel', status: 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('/instaops_accounts?')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) return { statusCode: 200, body: { id: TEST_IG_ID, username: 'vikas.sphere' } };
        if (req.url.includes('/cont_ok?')) return { statusCode: 200, body: { id: 'cont_ok', status_code: 'PUBLISHED' } };
        if (req.url.includes(`/${TEST_IG_ID}/media?`)) {
          return {
            statusCode: 200,
            body: {
              data: [{ id: 'ig_similar_only', caption: 'Unique Launch Reel', media_type: 'VIDEO', permalink: 'https://instagram.com/reel/Similar/' }],
            },
          };
        }
        if (req.url.includes('published_id=neq.')) return { statusCode: 200, body: [] };
        return { statusCode: 200, body: [] };
      },
    });
    assert.equal(asRecord(noPersistedIdRes.responded[0]?.body).verified, false);
    assert.equal(asRecord(noPersistedIdRes.responded[0]?.body).status, 'VERIFY_MANUALLY');

    // MARK_PUBLISHED with operator-supplied numeric published_id matching destination account & media_type -> PUBLISHED + lock cleared
    let clearedLock = false;
    const explicitOkRes = await runWorkflowDag(w05, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'VERIFY_PUBLICATION', post_uuid: TEST_POST_UUID, post_id: 'IG-REC-OK', resolution: 'MARK_PUBLISHED', published_id: '18044229100991122' },
      httpHandler: (req) => {
        if (req.url.includes('/instaops_posts?id=eq.')) {
          return { statusCode: 200, body: [{ id: TEST_POST_UUID, post_id: 'IG-REC-OK', ig_user_id: TEST_IG_ID, media_type: 'REEL', status: 'VERIFY_MANUALLY' }] };
        }
        if (req.url.includes('/instaops_accounts?')) return { statusCode: 200, body: [{ ig_user_id: TEST_IG_ID, enabled: true }] };
        if (req.url.includes(`/${TEST_IG_ID}?fields=id,username`)) return { statusCode: 200, body: { id: TEST_IG_ID, username: 'vikas.sphere' } };
        if (req.url.includes('/18044229100991122?')) {
          return {
            statusCode: 200,
            body: { id: '18044229100991122', media_type: 'VIDEO', owner: { id: TEST_IG_ID }, permalink: 'https://instagram.com/reel/Exact1/' },
          };
        }
        if (req.url.includes('instaops_posts?published_id=eq.')) return { statusCode: 200, body: [] };
        if (req.url.includes('/instaops_job_locks?') && req.method === 'DELETE') {
          clearedLock = true;
          return { statusCode: 200, body: [] };
        }
        return { statusCode: 200, body: [{}] };
      },
    });
    const exactBody = asRecord(explicitOkRes.responded[0]?.body);
    assert.equal(exactBody.verified, true);
    assert.equal(exactBody.status, 'PUBLISHED');
    assert.equal(exactBody.published_id, '18044229100991122');
    assert.equal(clearedLock, true);
  });

  it('W04 & W05 extra gates: blocks unresolved PUBLISH jobs, verifies Next.js lock ownership, and rejects mismatched Meta owner/type on published_id', async () => {
    const w04 = loadWorkflow('n8n/workflows/04-content-management.json');
    const w05 = loadWorkflow('n8n/workflows/05-recovery-reconciliation.json');
    const vars = {
      N8N_WEBHOOK_SECRET: TEST_SECRET,
      SUPABASE_URL: 'https://sb.example.supabase.co',
      CLOUDINARY_CLOUD_NAME: 'demo',
      INSTAGRAM_USER_ID: TEST_IG_ID,
    };

    const unresolvedRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-JOB', confirm: true },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_delete_enabled: true }] };
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

    const wrongOwnerRes = await runWorkflowDag(w04, {
      vars,
      webhookHeaders: { 'x-dashboard-secret': TEST_SECRET },
      webhookBody: { action: 'DELETE_MEDIA', post_uuid: TEST_POST_UUID, post_id: 'IG-DEL-OWN', confirm: true, lock_key: `post:${TEST_POST_UUID}`, lock_owner: 'wrong:owner' },
      httpHandler: (req) => {
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_delete_enabled: true }] };
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
        if (req.url.includes('instaops_get_runtime_settings')) return { statusCode: 200, body: [{ live_delete_enabled: true }] };
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
