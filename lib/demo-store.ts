import type {
  ContentRecord,
  ExecutionLogRecord,
  MediaAssetRecord,
  N8nExecutionSummary,
} from '../types/instaops';
import { DEFAULT_ACCOUNT_KEY, DEFAULT_IG_USER_ID, normalizeContentRecord, SCHEMA_VERSION } from './domain/schema';
import { buildOwnedPublicId } from './cloudinary/assets';

export interface DemoState {
  posts: ContentRecord[];
  assets: MediaAssetRecord[];
  logs: ExecutionLogRecord[];
  executions: N8nExecutionSummary[];
  schedulingEnabled: boolean;
}

const SAMPLE_CAROUSEL_URLS = Array.from({ length: 9 }, (_, idx) => ({
  idx,
  secureUrl: `https://res.cloudinary.com/djkkknb9k/image/upload/v179570000${idx}/instaops-v2/DEMO-CAROUSEL-09/item_${idx}.jpg`,
}));

function buildInitialDemoState(): DemoState {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

  const publishedPost = normalizeContentRecord({
    post_id: 'DEMO-PUB-01',
    source_instagram_url: 'https://www.instagram.com/reel/DEMOPUB01/',
    media_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1795700001/instaops-v2/DEMO-PUB-01/item_0_DEMOPUB01.mp4',
    media_type: 'REEL',
    original_caption: 'Workflow notes from local automation tests. #automation #n8n',
    caption: 'Clean two-step Instagram workflow checks completed. #automation #n8n',
    account_key: DEFAULT_ACCOUNT_KEY,
    ig_user_id: DEFAULT_IG_USER_ID,
    publish_mode: 'NOW',
    publish_at: '',
    status: 'PUBLISHED',
    published_id: '18099784871447176',
    published_url: 'https://www.instagram.com/reel/DEMO_LIVE_01/',
    error: '',
    processed_at: iso(-86400_000),
    schema_version: SCHEMA_VERSION,
    source_id: 'DEMOPUB01',
    source_username: 'vikas.sphere',
    source_kind: 'reel',
    canonical_url: 'https://www.instagram.com/reel/DEMOPUB01/',
    caption_status: 'available',
    caption_source: 'structured',
    hashtags_json: JSON.stringify(['#automation', '#n8n']),
    mentions_json: JSON.stringify([]),
    media_count: '1',
    image_count: '0',
    video_count: '1',
    source_like_count: '44',
    source_comment_count: '2',
    file_size_bytes: '8585271',
    revision: '2',
    approved_revision: '2',
    container_id: '179999000123456',
    published_at: iso(-86400_000),
    execution_id: 'demo-exec-101',
    request_id: 'demo-req-101',
    created_at: iso(-90000_000),
    updated_at: iso(-86400_000),
  });

  const readyReel = normalizeContentRecord({
    post_id: 'DEMO-READY-02',
    source_instagram_url: 'https://www.instagram.com/reel/DEMORDY02/',
    media_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/v1795700002/instaops-v2/DEMO-READY-02/item_0_DEMORDY02.mp4',
    media_type: 'REEL',
    original_caption: 'Step-by-step architecture walkthrough.',
    caption: 'Step-by-step architecture walkthrough with verified storage.',
    account_key: DEFAULT_ACCOUNT_KEY,
    ig_user_id: DEFAULT_IG_USER_ID,
    publish_mode: 'NOW',
    status: 'READY',
    schema_version: SCHEMA_VERSION,
    source_id: 'DEMORDY02',
    source_username: 'creator_sample',
    source_kind: 'reel',
    canonical_url: 'https://www.instagram.com/reel/DEMORDY02/',
    caption_status: 'available',
    caption_source: 'structured',
    hashtags_json: JSON.stringify([]),
    mentions_json: JSON.stringify([]),
    media_count: '1',
    image_count: '0',
    video_count: '1',
    source_like_count: '128',
    source_comment_count: '5',
    file_size_bytes: '12400120',
    revision: '1',
    approved_revision: '',
    created_at: iso(-7200_000),
    updated_at: iso(-3600_000),
    extracted_at: iso(-3600_000),
    uploaded_at: iso(-3600_000),
  });

  const carouselPost = normalizeContentRecord({
    post_id: 'DEMO-CAROUSEL-09',
    source_instagram_url: 'https://www.instagram.com/p/DEMOCAR09/',
    media_url: SAMPLE_CAROUSEL_URLS[0]!.secureUrl,
    media_type: 'CAROUSEL',
    original_caption: 'Nine-slide carousel extracted cleanly from hosted API. #design',
    caption: 'Nine-slide carousel extracted cleanly from hosted API. #design',
    account_key: DEFAULT_ACCOUNT_KEY,
    ig_user_id: DEFAULT_IG_USER_ID,
    publish_mode: 'NOW',
    status: 'READY',
    schema_version: SCHEMA_VERSION,
    source_id: 'DEMOCAR09',
    source_username: 'design_notes',
    source_kind: 'carousel',
    canonical_url: 'https://www.instagram.com/p/DEMOCAR09/',
    caption_status: 'available',
    caption_source: 'structured',
    hashtags_json: JSON.stringify(['#design']),
    mentions_json: JSON.stringify([]),
    media_count: '9',
    image_count: '9',
    video_count: '0',
    source_like_count: '210',
    source_comment_count: '12',
    file_size_bytes: String(9 * 420_000),
    revision: '1',
    created_at: iso(-5400_000),
    updated_at: iso(-1800_000),
    extracted_at: iso(-1800_000),
    uploaded_at: iso(-1800_000),
  });

  const assets: MediaAssetRecord[] = [
    {
      internal_asset_id: 'ast_DEMO-PUB-01_0',
      post_id: 'DEMO-PUB-01',
      media_index: 0,
      media_type: 'VIDEO',
      source_expires_at: '',
      cloudinary_public_id: buildOwnedPublicId('DEMO-PUB-01', 0, 'DEMOPUB01'),
      cloudinary_asset_id: 'cld_asset_pub01',
      secure_url: publishedPost.media_url,
      thumbnail_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/so_0/instaops-v2/DEMO-PUB-01/item_0_DEMOPUB01.jpg',
      resource_type: 'video',
      delivery_type: 'upload',
      format: 'mp4',
      file_size_bytes: 8585271,
      width: 1080,
      height: 1920,
      duration: 28.4,
      storage_status: 'ACTIVE',
      created_at: iso(-90000_000),
      updated_at: iso(-90000_000),
      deleted_at: '',
      error: '',
    },
    {
      internal_asset_id: 'ast_DEMO-READY-02_0',
      post_id: 'DEMO-READY-02',
      media_index: 0,
      media_type: 'VIDEO',
      source_expires_at: '',
      cloudinary_public_id: buildOwnedPublicId('DEMO-READY-02', 0, 'DEMORDY02'),
      cloudinary_asset_id: 'cld_asset_rdy02',
      secure_url: readyReel.media_url,
      thumbnail_url: 'https://res.cloudinary.com/djkkknb9k/video/upload/so_0/instaops-v2/DEMO-READY-02/item_0_DEMORDY02.jpg',
      resource_type: 'video',
      delivery_type: 'upload',
      format: 'mp4',
      file_size_bytes: 12400120,
      width: 1080,
      height: 1920,
      duration: 41.2,
      storage_status: 'ACTIVE',
      created_at: iso(-3600_000),
      updated_at: iso(-3600_000),
      deleted_at: '',
      error: '',
    },
    ...SAMPLE_CAROUSEL_URLS.map(
      (item): MediaAssetRecord => ({
        internal_asset_id: `ast_DEMO-CAROUSEL-09_${item.idx}`,
        post_id: 'DEMO-CAROUSEL-09',
        media_index: item.idx,
        media_type: 'IMAGE',
        source_expires_at: '',
        cloudinary_public_id: buildOwnedPublicId('DEMO-CAROUSEL-09', item.idx, 'DEMOCAR09'),
        cloudinary_asset_id: `cld_asset_car_${item.idx}`,
        secure_url: item.secureUrl,
        thumbnail_url: item.secureUrl,
        resource_type: 'image',
        delivery_type: 'upload',
        format: 'jpg',
        file_size_bytes: 420_000,
        width: 1080,
        height: 1350,
        duration: null,
        storage_status: 'ACTIVE',
        created_at: iso(-1800_000),
        updated_at: iso(-1800_000),
        deleted_at: '',
        error: '',
      }),
    ),
  ];

  const logs: ExecutionLogRecord[] = [
    {
      log_id: 'log-101',
      request_id: 'demo-req-101',
      execution_id: 'demo-exec-101',
      workflow_id: 'demo-w02',
      workflow_name: 'W02 Publish Content',
      post_id: 'DEMO-PUB-01',
      operation: 'PUBLISH',
      trigger_source: 'DASHBOARD',
      stage: 'COMPLETED',
      status: 'COMPLETED',
      started_at: iso(-86450_000),
      finished_at: iso(-86400_000),
      duration_ms: 50_000,
      error_code: '',
      error_message: '',
      retryable: false,
      created_at: iso(-86400_000),
    },
    {
      log_id: 'log-102',
      request_id: 'demo-req-102',
      execution_id: 'demo-exec-102',
      workflow_id: 'demo-w01',
      workflow_name: 'W01 Extract & Upload',
      post_id: 'DEMO-CAROUSEL-09',
      operation: 'EXTRACT',
      trigger_source: 'DASHBOARD',
      stage: 'COMPLETED',
      status: 'COMPLETED',
      started_at: iso(-1820_000),
      finished_at: iso(-1800_000),
      duration_ms: 20_000,
      error_code: '',
      error_message: '',
      retryable: false,
      created_at: iso(-1800_000),
    },
  ];

  const executions: N8nExecutionSummary[] = [
    {
      id: 'demo-exec-102',
      workflowId: 'demo-w01',
      workflowName: 'W01 Extract & Upload (Demo)',
      postId: 'DEMO-CAROUSEL-09',
      operation: 'EXTRACT',
      status: 'success',
      mode: 'webhook',
      startedAt: iso(-1820_000),
      stoppedAt: iso(-1800_000),
      finished: true,
      durationMs: 20_000,
    },
    {
      id: 'demo-exec-101',
      workflowId: 'demo-w02',
      workflowName: 'W02 Publish Content (Demo)',
      postId: 'DEMO-PUB-01',
      operation: 'PUBLISH',
      status: 'success',
      mode: 'webhook',
      startedAt: iso(-86450_000),
      stoppedAt: iso(-86400_000),
      finished: true,
      durationMs: 50_000,
    },
  ];

  return {
    posts: [publishedPost, readyReel, carouselPost],
    assets,
    logs,
    executions,
    schedulingEnabled: false,
  };
}

const g = globalThis as unknown as { __instaOpsV2Demo?: DemoState };

export function getDemoState(): DemoState {
  if (!g.__instaOpsV2Demo) {
    g.__instaOpsV2Demo = buildInitialDemoState();
  }
  return g.__instaOpsV2Demo;
}

export function resetDemoStateForTest(): void {
  g.__instaOpsV2Demo = buildInitialDemoState();
}
