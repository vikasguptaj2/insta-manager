import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { assertVerifiedWorkflowExport, type WorkflowJson } from '../../lib/n8n/workflow-safety';

interface HttpRequestOpts {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  json?: boolean;
  returnFullResponse?: boolean;
  ignoreHttpStatusErrors?: boolean;
  timeout?: number;
}

interface HttpMockResponse {
  statusCode: number;
  body: unknown;
  headers?: Record<string, string>;
}

function resolveRepoRoot(): string {
  const twoUp = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(twoUp, 'n8n', 'workflows'))) return twoUp;
  return path.resolve(__dirname, '..', '..', '..');
}

function loadWorkflow(relPath: string): WorkflowJson {
  const full = path.join(resolveRepoRoot(), relPath);
  return JSON.parse(fs.readFileSync(full, 'utf8')) as WorkflowJson;
}

async function execWorkflowCodeNode(
  wf: WorkflowJson,
  nodeName: string,
  opts: {
    inputItems?: Array<{ json: Record<string, unknown> }>;
    nodeOutputs?: Record<string, Array<{ json: Record<string, unknown> }>>;
    env?: Record<string, string>;
    vars?: Record<string, string>;
    blockEnvAccess?: boolean;
    executionId?: string;
    httpRequest?: (req: HttpRequestOpts) => Promise<HttpMockResponse | unknown>;
  } = {},
): Promise<Array<{ json: Record<string, unknown> }>> {
  const node = wf.nodes.find((n) => n.name === nodeName);
  assert.ok(node, `Workflow "${wf.name}" missing node "${nodeName}"`);
  const jsCode = typeof node.parameters?.jsCode === 'string' ? node.parameters.jsCode : '';
  assert.ok(jsCode.length > 0, `Node "${nodeName}" has empty jsCode`);

  const outputs = opts.nodeOutputs ?? {};
  const inputItems = opts.inputItems ?? [{ json: {} }];
  const nodeRefFn = (name: string) => {
    const items = outputs[name] ?? [{ json: {} }];
    return {
      item: items[0] ?? { json: {} },
      first: () => items[0] ?? { json: {} },
      all: () => items,
    };
  };

  const sandbox: Record<string, unknown> = {
    $: nodeRefFn,
    $input: {
      first: () => inputItems[0] ?? { json: {} },
      all: () => inputItems,
    },
    $execution: { id: opts.executionId ?? 'exec_vm_9001' },
    $vars: opts.vars ?? {},
    URL,
    URLSearchParams,
    Buffer,
    Date,
    Math,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    unescape: globalThis.unescape,
    setTimeout,
  };

  if (opts.blockEnvAccess) {
    sandbox.$env = new Proxy(
      {},
      {
        get() {
          throw new Error('access to env vars denied');
        },
        has() {
          throw new Error('access to env vars denied');
        },
        ownKeys() {
          throw new Error('access to env vars denied');
        },
      },
    );
  } else {
    sandbox.$env = opts.env ?? {};
  }

  const ctx = vm.createContext(sandbox);
  const compiled = vm.runInContext(`(function () {\n${jsCode}\n})`, ctx) as (
    this: { helpers?: { httpRequest?: (req: HttpRequestOpts) => Promise<unknown> } },
  ) => unknown;

  const result = compiled.call({
    helpers: {
      httpRequest:
        opts.httpRequest ??
        (async () => ({ statusCode: 200, body: {}, headers: {} })),
    },
  });
  return (await Promise.resolve(result)) as Array<{ json: Record<string, unknown> }>;
}

const TEST_SECRET = ['whsec', 'unit', 'secret', '001'].join('_');
const TEST_SB_KEY = ['sb', 'service', 'role', '001'].join('_');
const TEST_META_TOKEN = ['meta', 'graph', 'tok', '001'].join('_');
const TEST_DL_KEY = ['dl', 'api', 'key', '001'].join('_');
const TEST_CLD_KEY = 'cld_key_001';
const TEST_CLD_SECRET = ['cld', 'sec', '001'].join('_');

const POST_UUID = '11111111-1111-4111-8111-111111111111';
const IG_USER_ID = '17841453414532595';

describe('Executable n8n Workflow Exports (W01-W05)', () => {
  it('verifies static & structural contracts for all five exported workflow JSON files', () => {
    const roles: Array<['W01' | 'W02' | 'W03' | 'W04' | 'W05', string]> = [
      ['W01', 'n8n/workflows/01-extract-upload.json'],
      ['W02', 'n8n/workflows/02-publish-content.json'],
      ['W03', 'n8n/workflows/03-scheduled-runner.json'],
      ['W04', 'n8n/workflows/04-content-management.json'],
      ['W05', 'n8n/workflows/05-recovery-reconciliation.json'],
    ];
    for (const [role, file] of roles) {
      const wf = loadWorkflow(file);
      assert.doesNotThrow(() => assertVerifiedWorkflowExport(role, wf));
    }
  });

  it('W01: rejects bad auth/blocked env, blocks non-ready/expired downloader output, preserves partial Cloudinary checkpoints on failure, and finalizes ordered multi-item DRAFT cleanly', async () => {
    const w01 = loadWorkflow('n8n/workflows/01-extract-upload.json');

    // Hosted n8n $env blocked fail-closed check
    const blockedRes = await execWorkflowCodeNode(w01, 'CODE | Validate & Safeguard', {
      blockEnvAccess: true,
      inputItems: [{ json: { headers: {}, body: {} } }],
    });
    assert.equal(blockedRes[0]?.json.valid, false);
    assert.equal(blockedRes[0]?.json.httpStatus, 500);
    assert.match(String(blockedRes[0]?.json.error), /N8N_BLOCK_ENV_ACCESS_IN_NODE/i);

    // Valid request validation using $vars fallback when $env is blocked!
    const okVal = await execWorkflowCodeNode(w01, 'CODE | Validate & Safeguard', {
      blockEnvAccess: true,
      vars: { N8N_WEBHOOK_SECRET: TEST_SECRET },
      inputItems: [
        {
          json: {
            headers: { 'x-dashboard-secret': TEST_SECRET },
            body: {
              post_uuid: POST_UUID,
              post_id: 'IG-EXT-1',
              source_instagram_url: 'https://www.instagram.com/p/C8CarouselTest/',
              authorized: true,
              request_id: 'req-ext-1',
              job_id: 'job_ext_1',
              lock_key: `post:${POST_UUID}`,
              lock_owner: 'ext:req-ext-1',
            },
          },
        },
      ],
    });
    assert.equal(okVal[0]?.json.valid, true);

    const validatedItem = okVal[0]!;
    const baseEnv = {
      SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: TEST_SB_KEY,
      DOWNLOADER_BASE_URL: 'https://instagram-downloader-psi-one.vercel.app',
      DOWNLOADER_API_KEY: TEST_DL_KEY,
      CLOUDINARY_CLOUD_NAME: 'djkkknb9k',
      CLOUDINARY_API_KEY: TEST_CLD_KEY,
      CLOUDINARY_API_SECRET: TEST_CLD_SECRET,
    };

    // Case A: Downloader returns ok:true, status:'pending' -> must NOT mark DRAFT!
    let finalizeCalls: Array<Record<string, unknown>> = [];
    const pendingRes = await execWorkflowCodeNode(w01, 'CODE | Atomic Lock, Download, Upload & Finalize Extraction', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Validate & Safeguard': [validatedItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('/rest/v1/instaops_posts')) return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-EXT-1', status: 'DRAFT', media_type: 'REEL', caption: '' }] };
        if (req.url.includes('/api/n8n/resolve')) return { statusCode: 200, body: { ok: true, status: 'pending', media: [{ url: 'https://cdn.example/a.mp4' }] } };
        if (req.url.includes('instaops_finalize_extraction')) {
          finalizeCalls.push(req.body as Record<string, unknown>);
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(pendingRes[0]?.json.status, 'FAILED');
    assert.equal((finalizeCalls[0]?.p_post_patch as Record<string, unknown>)?.status, 'FAILED');

    // Case B: Downloader returns expired temporary URL -> rejected BEFORE Cloudinary
    let cldCalledOnExpired = false;
    finalizeCalls = [];
    const expRes = await execWorkflowCodeNode(w01, 'CODE | Atomic Lock, Download, Upload & Finalize Extraction', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Validate & Safeguard': [validatedItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('/rest/v1/instaops_posts')) return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-EXT-1', status: 'DRAFT', media_type: 'IMAGE', caption: '' }] };
        if (req.url.includes('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: { ok: true, status: 'ready', media: [{ url: 'https://scontent.cdninstagram.com/v/a.jpg', expiresAt: '2020-01-01T00:00:00Z' }] },
          };
        }
        if (req.url.includes('api.cloudinary.com')) cldCalledOnExpired = true;
        if (req.url.includes('instaops_finalize_extraction')) {
          finalizeCalls.push(req.body as Record<string, unknown>);
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(cldCalledOnExpired, false);
    assert.equal(expRes[0]?.json.error_code, 'MEDIA_URL_EXPIRED');

    // Case C: Partial Cloudinary failure on 2nd of 2 items -> preserves 1st asset checkpoint, keeps FAILED (never DRAFT)
    finalizeCalls = [];
    let cldIdx = 0;
    const partialRes = await execWorkflowCodeNode(w01, 'CODE | Atomic Lock, Download, Upload & Finalize Extraction', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Validate & Safeguard': [validatedItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('/rest/v1/instaops_posts')) return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-EXT-1', status: 'DRAFT', media_type: 'CAROUSEL', caption: '' }] };
        if (req.url.includes('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'ready',
              media: [
                { url: 'https://scontent.cdninstagram.com/v/item0.jpg', type: 'IMAGE' },
                { url: 'https://scontent.cdninstagram.com/v/item1.mp4', type: 'VIDEO' },
              ],
            },
          };
        }
        if (req.url.includes('api.cloudinary.com')) {
          cldIdx++;
          if (cldIdx === 1) {
            return {
              statusCode: 200,
              body: { secure_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/instaops/IG-EXT-1/item_0.jpg', public_id: 'instaops/IG-EXT-1/item_0', bytes: 1000 },
            };
          }
          return { statusCode: 500, body: { error: { message: 'Cloudinary temporary error' } } };
        }
        if (req.url.includes('instaops_finalize_extraction')) {
          finalizeCalls.push(req.body as Record<string, unknown>);
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(partialRes[0]?.json.status, 'FAILED');
    assert.equal(partialRes[0]?.json.partial_assets, 1);
    assert.equal((finalizeCalls[0]?.p_assets as unknown[]).length, 1);
    assert.equal((finalizeCalls[0]?.p_post_patch as Record<string, unknown>)?.status, 'FAILED');

    // Case D: Full 3-item mixed carousel succeeds -> DRAFT, order preserved, zero media_publish calls
    finalizeCalls = [];
    let upCount = 0;
    const happyRes = await execWorkflowCodeNode(w01, 'CODE | Atomic Lock, Download, Upload & Finalize Extraction', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Validate & Safeguard': [validatedItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('/rest/v1/instaops_posts')) return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-EXT-1', status: 'DRAFT', media_type: 'REEL', caption: '' }] };
        if (req.url.includes('/api/n8n/resolve')) {
          return {
            statusCode: 200,
            body: {
              ok: true,
              status: 'ready',
              caption: 'Extracted IG caption #test',
              media: [
                { url: 'https://scontent.cdninstagram.com/v/0.jpg', type: 'IMAGE' },
                { url: 'https://scontent.cdninstagram.com/v/1.mp4', type: 'VIDEO' },
                { url: 'https://scontent.cdninstagram.com/v/2.jpg', type: 'IMAGE' },
              ],
            },
          };
        }
        if (req.url.includes('api.cloudinary.com')) {
          const i = upCount++;
          const isVid = i === 1;
          return {
            statusCode: 200,
            body: {
              secure_url: `https://res.cloudinary.com/djkkknb9k/${isVid ? 'video' : 'image'}/upload/v1/instaops/IG-EXT-1/item_${i}.${isVid ? 'mp4' : 'jpg'}`,
              public_id: `instaops/IG-EXT-1/item_${i}`,
              bytes: 2048,
            },
          };
        }
        if (req.url.includes('instaops_finalize_extraction')) {
          finalizeCalls.push(req.body as Record<string, unknown>);
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(happyRes[0]?.json.ok, true);
    assert.equal(happyRes[0]?.json.status, 'DRAFT');
    assert.equal(happyRes[0]?.json.media_type, 'CAROUSEL');
    assert.equal((finalizeCalls[0]?.p_assets as Array<Record<string, unknown>>).map((a) => a.media_index).join(','), '0,1,2');
  });

  it('W02: enforces LIVE_PUBLISH_ENABLED inside W02, fixes revision OR-check, supports 9-image & mixed carousels, aborts partial carousel, persists published_id before permalink error, and preserves lock on publish timeout', async () => {
    const w02 = loadWorkflow('n8n/workflows/02-publish-content.json');

    // Inside W02 LIVE_PUBLISH_ENABLED=false rejection
    const liveOffRes = await execWorkflowCodeNode(w02, 'CODE | Verify Auth & Approval Gate', {
      env: { N8N_WEBHOOK_SECRET: TEST_SECRET, LIVE_PUBLISH_ENABLED: 'false' },
      inputItems: [
        {
          json: {
            headers: { 'x-dashboard-secret': TEST_SECRET },
            body: { post_uuid: POST_UUID, post_id: 'IG-PUB-1', reviewed_revision: '2', confirm: true },
          },
        },
      ],
    });
    assert.equal(liveOffRes[0]?.json.valid, false);
    assert.equal(liveOffRes[0]?.json.httpStatus, 409);

    const validGate = await execWorkflowCodeNode(w02, 'CODE | Verify Auth & Approval Gate', {
      env: { N8N_WEBHOOK_SECRET: TEST_SECRET, LIVE_PUBLISH_ENABLED: 'true' },
      inputItems: [
        {
          json: {
            headers: { 'x-dashboard-secret': TEST_SECRET },
            body: {
              post_uuid: POST_UUID,
              post_id: 'IG-PUB-1',
              ig_user_id: IG_USER_ID,
              reviewed_revision: '2',
              approved_revision: '2',
              media_items: [{ secure_url: 'https://evil-spoof.example/hacked.mp4' }],
              confirm: true,
              request_id: 'req-pub-1',
              job_id: 'job_pub_1',
              lock_key: `post:${POST_UUID}`,
              lock_owner: 'pub:req-pub-1',
            },
          },
        },
      ],
    });
    assert.equal(validGate[0]?.json.valid, true);
    const gateItem = validGate[0]!;

    const baseEnv = {
      SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: TEST_SB_KEY,
      META_GRAPH_TOKEN: TEST_META_TOKEN,
      INSTAGRAM_GRAPH_VERSION: 'v22.0',
      LIVE_PUBLISH_ENABLED: 'true',
      N8N_GRAPH_POLL_INTERVAL_MS: '0',
      N8N_GRAPH_MAX_POLLS: '5',
    };

    // Case 1: Logical-OR revision bug regression check: reviewed_revision===2, revision===2, approved_revision===1 -> MUST REJECT & release lock!
    let releaseCalled = false;
    const revMismatchRes = await execWorkflowCodeNode(w02, 'CODE | Authoritative Gate, Carousel & Bounded Meta Publish', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Verify Auth & Approval Gate': [gateItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('/rest/v1/instaops_posts')) {
          return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-PUB-1', status: 'READY', revision: 2, approved_revision: 1, ig_user_id: IG_USER_ID, media_type: 'IMAGE', caption: 'hi' }] };
        }
        if (req.url.includes('instaops_release_lock')) {
          releaseCalled = true;
          return { statusCode: 200, body: true };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(revMismatchRes[0]?.json.error_code, 'REVISION_CONFLICT');
    assert.equal(releaseCalled, true);

    // Case 2: 9-image carousel + ignores spoofed request URLs + permalink failure AFTER media_publish STILL keeps PUBLISHED + single publish call!
    let mediaPublishCalls = 0;
    const childPayloads: Array<Record<string, unknown>> = [];
    const postPatches: Array<Record<string, unknown>> = [];
    const asset9List = Array.from({ length: 9 }, (_, i) => ({
      id: `ast-uuid-${i}`,
      internal_asset_id: `ast_IG-PUB-1_${i}`,
      post_uuid: POST_UUID,
      media_index: i,
      media_type: 'IMAGE',
      resource_type: 'image',
      storage_status: 'ACTIVE',
      secure_url: `https://res.cloudinary.com/djkkknb9k/image/upload/v1/instaops/IG-PUB-1/item_${i}.jpg`,
    }));

    const nineImgRes = await execWorkflowCodeNode(w02, 'CODE | Authoritative Gate, Carousel & Bounded Meta Publish', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Verify Auth & Approval Gate': [gateItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_renew_lock')) return { statusCode: 200, body: [{ renewed: true }] };
        if (req.url.includes('instaops_release_lock')) return { statusCode: 200, body: true };
        if (req.url.includes('/rest/v1/instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-PUB-1', status: 'READY', revision: 2, approved_revision: 2, ig_user_id: IG_USER_ID, media_type: 'CAROUSEL', caption: '9-slide gallery' }] };
        }
        if (req.url.includes('/rest/v1/instaops_posts') && req.method === 'PATCH') {
          postPatches.push(req.body as Record<string, unknown>);
          return { statusCode: 200, body: [Object.assign({ id: POST_UUID, post_id: 'IG-PUB-1' }, req.body)] };
        }
        if (req.url.includes('/rest/v1/instaops_accounts')) return { statusCode: 200, body: [{ id: 'acc-1', enabled: true, ig_user_id: IG_USER_ID }] };
        if (req.url.includes('/rest/v1/instaops_media_assets') && req.method === 'GET') return { statusCode: 200, body: asset9List };
        if (req.url.includes(`/${IG_USER_ID}/media_publish`)) {
          mediaPublishCalls++;
          return { statusCode: 200, body: { id: 'ig_pub_999' } };
        }
        if (req.url.includes(`/${IG_USER_ID}/media`)) {
          const b = req.body as Record<string, unknown>;
          if (b.is_carousel_item) {
            childPayloads.push(b);
            assert.doesNotMatch(String(b.image_url), /evil-spoof\.example/);
            return { statusCode: 200, body: { id: `child_${childPayloads.length}` } };
          }
          return { statusCode: 200, body: { id: 'parent_carousel_1' } };
        }
        if (req.url.includes('/parent_carousel_1?fields=id,status_code')) {
          return { statusCode: 200, body: { id: 'parent_carousel_1', status_code: 'FINISHED' } };
        }
        if (req.url.includes('/ig_pub_999?fields=id,permalink')) {
          throw new Error('Transient permalink timeout');
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(childPayloads.length, 9);
    assert.equal(mediaPublishCalls, 1);
    assert.equal(nineImgRes[0]?.json.ok, true);
    assert.equal(nineImgRes[0]?.json.status, 'PUBLISHED');
    assert.equal(nineImgRes[0]?.json.published_id, 'ig_pub_999');
    assert.ok(postPatches.some((p) => p.status === 'PUBLISHED' && p.published_id === 'ig_pub_999'));

    // Case 3: Mixed Image + Video Carousel polls video child IN_PROGRESS -> FINISHED and renews lock
    let videoChildPolls = 0;
    let renewCount = 0;
    const mixedRes = await execWorkflowCodeNode(w02, 'CODE | Authoritative Gate, Carousel & Bounded Meta Publish', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Verify Auth & Approval Gate': [gateItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_renew_lock')) { renewCount++; return { statusCode: 200, body: [{ renewed: true }] }; }
        if (req.url.includes('instaops_release_lock')) return { statusCode: 200, body: true };
        if (req.url.includes('/rest/v1/instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-PUB-1', status: 'READY', revision: 2, approved_revision: 2, ig_user_id: IG_USER_ID, media_type: 'CAROUSEL', caption: 'Mixed' }] };
        }
        if (req.url.includes('/rest/v1/instaops_accounts')) return { statusCode: 200, body: [{ id: 'acc-1', enabled: true, ig_user_id: IG_USER_ID }] };
        if (req.url.includes('/rest/v1/instaops_media_assets') && req.method === 'GET') {
          return {
            statusCode: 200,
            body: [
              { id: 'a0', internal_asset_id: 'a0', post_uuid: POST_UUID, media_index: 0, media_type: 'IMAGE', resource_type: 'image', storage_status: 'ACTIVE', secure_url: 'https://res.cloudinary.com/djkkknb9k/image/upload/v1/0.jpg' },
              { id: 'a1', internal_asset_id: 'a1', post_uuid: POST_UUID, media_index: 1, media_type: 'VIDEO', resource_type: 'video', storage_status: 'ACTIVE', secure_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1/1.mp4' },
            ],
          };
        }
        if (req.url.includes(`/${IG_USER_ID}/media_publish`)) return { statusCode: 200, body: { id: 'ig_mixed_pub_1' } };
        if (req.url.includes(`/${IG_USER_ID}/media`)) {
          const b = req.body as Record<string, unknown>;
          if (b.is_carousel_item) return { statusCode: 200, body: { id: b.media_type === 'VIDEO' ? 'vid_child_1' : 'img_child_0' } };
          return { statusCode: 200, body: { id: 'parent_mixed_1' } };
        }
        if (req.url.includes('/vid_child_1?fields=id,status_code')) {
          videoChildPolls++;
          return { statusCode: 200, body: { id: 'vid_child_1', status_code: videoChildPolls < 3 ? 'IN_PROGRESS' : 'FINISHED' } };
        }
        if (req.url.includes('/parent_mixed_1?fields=id,status_code')) return { statusCode: 200, body: { id: 'parent_mixed_1', status_code: 'FINISHED' } };
        if (req.url.includes('/ig_mixed_pub_1?fields=id,permalink')) return { statusCode: 200, body: { id: 'ig_mixed_pub_1', permalink: 'https://www.instagram.com/p/Mixed1/' } };
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(videoChildPolls, 3);
    assert.ok(renewCount >= 1);
    assert.equal(mixedRes[0]?.json.status, 'PUBLISHED');
    assert.equal(mixedRes[0]?.json.published_url, 'https://www.instagram.com/p/Mixed1/');

    // Case 4: Child container creation failure aborts partial carousel cleanly without creating parent or publishing
    let parentCreatedOnFail = false;
    let cCall = 0;
    const childAbortRes = await execWorkflowCodeNode(w02, 'CODE | Authoritative Gate, Carousel & Bounded Meta Publish', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Verify Auth & Approval Gate': [gateItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_release_lock')) return { statusCode: 200, body: true };
        if (req.url.includes('/rest/v1/instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-PUB-1', status: 'READY', revision: 2, approved_revision: 2, ig_user_id: IG_USER_ID, media_type: 'CAROUSEL', caption: 'Abort' }] };
        }
        if (req.url.includes('/rest/v1/instaops_accounts')) return { statusCode: 200, body: [{ id: 'acc-1', enabled: true, ig_user_id: IG_USER_ID }] };
        if (req.url.includes('/rest/v1/instaops_media_assets') && req.method === 'GET') return { statusCode: 200, body: asset9List.slice(0, 3) };
        if (req.url.includes(`/${IG_USER_ID}/media`)) {
          const b = req.body as Record<string, unknown>;
          if (!b.is_carousel_item) parentCreatedOnFail = true;
          cCall++;
          if (cCall === 2) return { statusCode: 400, body: { error: { message: 'Invalid image format' } } };
          return { statusCode: 200, body: { id: `child_${cCall}` } };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(parentCreatedOnFail, false);
    assert.equal(childAbortRes[0]?.json.status, 'FAILED');
    assert.equal(childAbortRes[0]?.json.error_code, 'CAROUSEL_CHILD_FAILED');

    // Case 5: Uncertain timeout during media_publish preserves lock + sets VERIFY_MANUALLY & PUBLISH_OUTCOME_UNKNOWN
    let lockReleasedOnTimeout = false;
    const timeoutRes = await execWorkflowCodeNode(w02, 'CODE | Authoritative Gate, Carousel & Bounded Meta Publish', {
      env: baseEnv,
      nodeOutputs: { 'CODE | Verify Auth & Approval Gate': [gateItem] },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_transfer_or_claim_lock')) return { statusCode: 200, body: [{ acquired: true }] };
        if (req.url.includes('instaops_renew_lock')) return { statusCode: 200, body: [{ renewed: true }] };
        if (req.url.includes('instaops_release_lock')) { lockReleasedOnTimeout = true; return { statusCode: 200, body: true }; }
        if (req.url.includes('/rest/v1/instaops_posts') && req.method === 'GET') {
          return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-PUB-1', status: 'READY', revision: 2, approved_revision: 2, ig_user_id: IG_USER_ID, media_type: 'IMAGE', caption: 'Single' }] };
        }
        if (req.url.includes('/rest/v1/instaops_accounts')) return { statusCode: 200, body: [{ id: 'acc-1', enabled: true, ig_user_id: IG_USER_ID }] };
        if (req.url.includes('/rest/v1/instaops_media_assets') && req.method === 'GET') return { statusCode: 200, body: asset9List.slice(0, 1) };
        if (req.url.includes(`/${IG_USER_ID}/media_publish`)) throw new Error('ESOCKETTIMEDOUT');
        if (req.url.includes(`/${IG_USER_ID}/media`)) return { statusCode: 200, body: { id: 'single_c_1' } };
        if (req.url.includes('/single_c_1?fields=id,status_code')) return { statusCode: 200, body: { id: 'single_c_1', status_code: 'FINISHED' } };
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(lockReleasedOnTimeout, false);
    assert.equal(timeoutRes[0]?.json.status, 'VERIFY_MANUALLY');
    assert.equal(timeoutRes[0]?.json.error_code, 'PUBLISH_OUTCOME_UNKNOWN');
    assert.equal(timeoutRes[0]?.json.lock_preserved, true);
  });

  it('W03, W04 & W05: scheduled atomic claim handoff, outbox multi-tab sync/verification, hardened Cloudinary destroy, empty sheet probe & Graph-verified reconciliation', async () => {
    const w03 = loadWorkflow('n8n/workflows/03-scheduled-runner.json');
    const w04 = loadWorkflow('n8n/workflows/04-content-management.json');
    const w05 = loadWorkflow('n8n/workflows/05-recovery-reconciliation.json');

    // W03 claims atomically & hands off lock to W02
    let w02DispatchBody: Record<string, unknown> | null = null;
    const schedOut = await execWorkflowCodeNode(w03, 'CODE | Atomic Due Claim & Dispatch to W02', {
      env: {
        SCHEDULING_ENABLED: 'true',
        LIVE_PUBLISH_ENABLED: 'true',
        SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: TEST_SB_KEY,
        N8N_BASE_URL: 'https://137.23.61.127.sslip.io',
        N8N_WEBHOOK_SECRET: TEST_SECRET,
      },
      httpRequest: async (req) => {
        if (req.url.includes('instaops_claim_due_scheduled_posts')) {
          return {
            statusCode: 200,
            body: [
              {
                post_uuid: POST_UUID,
                post_id: 'IG-SCH-1',
                ig_user_id: IG_USER_ID,
                media_type: 'REEL',
                caption: 'Due scheduled reel',
                media_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1/a.mp4',
                revision: 3,
                approved_revision: 3,
                lock_key: `post:${POST_UUID}`,
                lock_owner: 'w03:exec_vm_9001',
                job_id: 'job_sch_1',
                request_id: 'req_sch_1',
                media_items: [{ id: 'ast1' }],
              },
            ],
          };
        }
        if (req.url.includes('/webhook/instaops-publish-v1')) {
          w02DispatchBody = req.body as Record<string, unknown>;
          return { statusCode: 202, body: { accepted: true, execution_id: 'w02_exec_1' } };
        }
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(schedOut[0]?.json.dispatched, true);
    assert.equal(w02DispatchBody?.['lock_key'], `post:${POST_UUID}`);
    assert.equal(w02DispatchBody?.['lock_owner'], 'w03:exec_vm_9001');

    // W04 refuses LIVE_DELETE_ENABLED=false inside W04
    const delBlocked = await execWorkflowCodeNode(w04, 'CODE | Validate Content & Sync Action', {
      env: { N8N_WEBHOOK_SECRET: TEST_SECRET, LIVE_DELETE_ENABLED: 'false' },
      inputItems: [{ json: { headers: { 'x-dashboard-secret': TEST_SECRET }, body: { action: 'DELETE_POST', confirm: true, post_id: 'X' } } }],
    });
    assert.equal(delBlocked[0]?.json.valid, false);
    assert.equal(delBlocked[0]?.json.httpStatus, 409);

    // W04 outbox Verify Outbox Sheet Write fails on empty unverified result, succeeds on matching ID
    const syncUnverified = await execWorkflowCodeNode(w04, 'CODE | Verify Outbox Sheet Write', {
      nodeOutputs: { 'CODE | Validate Content & Sync Action': [{ json: { body: { sync_id: 's1' }, entity_type: 'POST', entity_uuid: POST_UUID, post_id: 'IG-1' } }] },
      inputItems: [{ json: {} }],
    });
    assert.equal(syncUnverified[0]?.json.synced, false);

    // W04 Hardened Cloudinary Destroy rejects foreign asset not owned by post_uuid & surfaces partial failure accurately
    const delValidate = await execWorkflowCodeNode(w04, 'CODE | Validate Content & Sync Action', {
      env: { N8N_WEBHOOK_SECRET: TEST_SECRET, LIVE_DELETE_ENABLED: 'true' },
      inputItems: [
        {
          json: {
            headers: { 'x-dashboard-secret': TEST_SECRET },
            body: { action: 'DELETE_MEDIA', confirm: true, post_uuid: POST_UUID, post_id: 'IG-DEL-1', asset_ids: ['owned_1', 'foreign_2'] },
          },
        },
      ],
    });
    const delRes = await execWorkflowCodeNode(w04, 'CODE | Hardened Cloudinary Destroy Orchestrator', {
      env: {
        SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: TEST_SB_KEY,
        CLOUDINARY_CLOUD_NAME: 'djkkknb9k',
        CLOUDINARY_API_KEY: TEST_CLD_KEY,
        CLOUDINARY_API_SECRET: TEST_CLD_SECRET,
        LIVE_DELETE_ENABLED: 'true',
      },
      nodeOutputs: { 'CODE | Validate Content & Sync Action': delValidate },
      httpRequest: async (req) => {
        if (req.url.includes('/rest/v1/instaops_posts')) return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-DEL-1', status: 'DRAFT' }] };
        if (req.url.includes('/rest/v1/instaops_media_assets')) {
          return {
            statusCode: 200,
            body: [{ id: 'ast_u1', post_uuid: POST_UUID, internal_asset_id: 'owned_1', cloudinary_public_id: 'instaops/IG-DEL-1/item_0', resource_type: 'image', delivery_type: 'authenticated', storage_status: 'ACTIVE' }],
          };
        }
        if (req.url.includes('/image/destroy')) return { statusCode: 200, body: { result: 'ok' } };
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(delRes[0]?.json.partial_failure, true);
    const outs = delRes[0]?.json.outcomes as Array<Record<string, unknown>>;
    assert.equal(outs.find((o) => o.internal_asset_id === 'owned_1')?.result, 'ok');
    assert.equal(outs.find((o) => o.internal_asset_id === 'foreign_2')?.result, 'error');

    // W05 empty sheet probe + $env blocked surfacing + Meta Graph verified MARK_PUBLISHED guard
    const healthProbe = await execWorkflowCodeNode(w05, 'CODE | Run Service & Env Health Probes', {
      blockEnvAccess: true,
      vars: {
        N8N_WEBHOOK_SECRET: TEST_SECRET,
        SUPABASE_SERVICE_ROLE_KEY: TEST_SB_KEY,
        LIVE_PUBLISH_ENABLED: 'false',
        LIVE_DELETE_ENABLED: 'false',
        SCHEDULING_ENABLED: 'false',
      },
      inputItems: [], // empty Posts sheet with alwaysOutputData:true
      httpRequest: async (req) => {
        if (req.url.includes('instaops_verify_health_and_rpc')) {
          return { statusCode: 200, body: [{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, detail: 'tables=10/10' }] };
        }
        return { statusCode: 401, body: { error: { message: 'missing creds' } } };
      },
    });
    const services = healthProbe[0]?.json.services as Record<string, Record<string, unknown>>;
    assert.equal(services.sheets?.ok, true);
    assert.equal(services.supabase?.ok, true);
    assert.equal(services.n8nEnv?.envBlocked, true);

    // W05 refuses unverified client-supplied MARK_PUBLISHED when Graph returns 404
    const fakePubReject = await execWorkflowCodeNode(w05, 'CODE | Provider-Verified Reconciliation', {
      env: {
        SUPABASE_URL: 'https://cdgwdlhesgcxmswsamrj.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: TEST_SB_KEY,
        META_GRAPH_TOKEN: TEST_META_TOKEN,
      },
      nodeOutputs: {
        'CODE | Validate Recovery Operation': [{ json: { post_uuid: POST_UUID, post_id: 'IG-REC-1', resolution: 'MARK_PUBLISHED', published_id: '17900000000', ig_user_id: IG_USER_ID } }],
      },
      httpRequest: async (req) => {
        if (req.url.includes('/rest/v1/instaops_posts')) return { statusCode: 200, body: [{ id: POST_UUID, post_id: 'IG-REC-1', status: 'VERIFY_MANUALLY', ig_user_id: IG_USER_ID }] };
        if (req.url.includes('graph.facebook.com')) return { statusCode: 404, body: { error: { message: 'Object does not exist' } } };
        return { statusCode: 200, body: {} };
      },
    });
    assert.equal(fakePubReject[0]?.json.verified, false);
    assert.equal(fakePubReject[0]?.json.status, 'VERIFY_MANUALLY');
  });
});
