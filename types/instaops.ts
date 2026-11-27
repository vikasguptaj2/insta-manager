export type ContentStatus =
  | 'DRAFT'
  | 'EXTRACTING'
  | 'UPLOADING'
  | 'READY'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'VERIFY_MANUALLY'
  | 'ARCHIVED'
  | 'DELETING'
  | 'MEDIA_DELETED'
  | 'DELETED';

export type JobStage =
  | 'QUEUED'
  | 'VALIDATING'
  | 'FETCHING_SOURCE'
  | 'DOWNLOADING'
  | 'UPLOADING_MEDIA'
  | 'SAVING_RECORDS'
  | 'CREATING_CONTAINER'
  | 'PROCESSING_CONTAINER'
  | 'PUBLISH_REQUESTED'
  | 'VERIFYING_PUBLICATION'
  | 'DELETING_ASSETS'
  | 'RECONCILING'
  | 'COMPLETED'
  | 'FAILED'
  | 'OUTCOME_UNKNOWN';

export type MediaType = 'REEL' | 'IMAGE' | 'CAROUSEL';
export type PublishMode = 'NOW' | 'LATER';
export type CaptionStatus = 'available' | 'empty' | 'unavailable' | 'unknown';
export type StorageStatus = 'ACTIVE' | 'DELETE_PENDING' | 'DELETED' | 'PARTIAL_DELETE' | 'UNMANAGED' | 'FAILED';

export type JobOperation =
  | 'EXTRACT'
  | 'PUBLISH'
  | 'SCHEDULE'
  | 'CANCEL_SCHEDULE'
  | 'DELETE_MEDIA'
  | 'DELETE_POST'
  | 'RECONCILE'
  | 'RETRY'
  | 'AI_REWRITE';

export interface ContentRecord {
  // Permanent Supabase primary UUID + synced Google Sheet ID
  id?: string;
  // Legacy 15 columns (preserved in exact order)
  post_id: string;
  source_instagram_url: string;
  media_url: string;
  media_type: MediaType;
  original_caption: string;
  caption: string;
  account_key: string;
  ig_user_id: string;
  publish_mode: PublishMode;
  publish_at: string;
  status: ContentStatus;
  published_id: string;
  published_url: string;
  error: string;
  processed_at: string;

  // Extended v2.0 columns
  schema_version: string;
  source_id: string;
  source_username: string;
  source_kind: string;
  canonical_url: string;
  caption_status: CaptionStatus;
  caption_source: string;
  hashtags_json: string;
  mentions_json: string;
  media_count: string;
  image_count: string;
  video_count: string;
  source_published_at: string;
  source_like_count: string;
  source_comment_count: string;
  source_play_count: string;
  source_metadata_json: string;
  file_size_bytes: string;
  revision: string;
  approved_revision: string;
  container_id: string;
  child_container_ids?: string;
  published_at: string;
  execution_id: string;
  request_id: string;
  retry_count: string;
  error_code: string;
  error_stage: string;
  sheets_sync_status?: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'SKIPPED';
  sheets_synced_at?: string;
  sheets_sync_error?: string;
  created_at: string;
  updated_at: string;
  extracted_at: string;
  uploaded_at: string;
  archived_at: string;
  deleted_at: string;
}

export interface MediaAssetRecord {
  id?: string;
  post_uuid?: string;
  internal_asset_id: string;
  post_id: string;
  media_index: number;
  media_type: 'IMAGE' | 'VIDEO';
  source_expires_at: string;
  cloudinary_public_id: string;
  cloudinary_asset_id: string;
  secure_url: string;
  thumbnail_url: string;
  resource_type: 'image' | 'video';
  delivery_type: 'upload' | 'authenticated' | 'private';
  format: string;
  file_size_bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  ig_child_container_id?: string;
  storage_status: StorageStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string;
  error: string;
}

export interface ExecutionLogRecord {
  log_id: string;
  request_id: string;
  execution_id: string;
  workflow_id: string;
  workflow_name: string;
  post_id: string;
  operation: JobOperation | string;
  trigger_source: string;
  stage: JobStage | string;
  status: string;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
  error_code: string;
  error_message: string;
  retryable: boolean;
  created_at: string;
}

export interface AccountRecord {
  account_key: string;
  account_label: string;
  ig_user_id: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface DurableJob {
  job_id: string;
  request_id: string;
  execution_id: string;
  post_id: string;
  operation: JobOperation;
  stage: JobStage;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'OUTCOME_UNKNOWN';
  lock_key?: string;
  lock_owner?: string;
  error_code?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
  finished_at?: string;
}

export interface JobLock {
  lock_key: string;
  post_uuid?: string;
  post_id: string;
  operation: JobOperation;
  owner_id: string;
  request_id: string;
  acquired_at: string;
  expires_at: string;
}

export interface DownloaderMediaItem {
  type: 'image' | 'video';
  url: string;
  thumbnailUrl?: string;
  fileSizeBytes?: number | null;
  expiresAt?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface DownloaderResolveResult {
  ok: boolean;
  status: string;
  platform: string;
  kind: string;
  canonicalUrl: string;
  embedUrl?: string;
  sourceUsername?: string;
  sourceId: string;
  caption: string;
  captionSource: string;
  captionStatus: CaptionStatus;
  hashtags: string[];
  mentions: string[];
  postMetadata: {
    mediaCount: number;
    imageCount: number;
    videoCount: number;
    publishedAt?: string | null;
    likeCount?: number | null;
    commentCount?: number | null;
    playCount?: number | null;
    width?: number | null;
    height?: number | null;
    fileSizeBytes?: number | null;
  };
  media: DownloaderMediaItem[];
}

export type DiagnosticState =
  | 'connected'
  | 'not_configured'
  | 'auth_rejected'
  | 'workflow_inactive'
  | 'webhook_unavailable'
  | 'timeout'
  | 'invalid_response'
  | 'provider_error'
  | 'not_tested';

export interface ServiceConnectionStatus {
  id: 'supabase' | 'n8n' | 'downloader' | 'sheets' | 'cloudinary' | 'instagram' | 'lockStore' | 'ai';
  name: string;
  status: 'connected' | 'degraded' | 'offline' | 'unconfigured';
  diagnosticState?: DiagnosticState;
  httpStatus?: number | null;
  errorCode?: string;
  requestId?: string;
  executionId?: string;
  fromCache?: boolean;
  detail: string;
  checkedAt: string;
  latencyMs?: number;
}

export interface WorkflowIntegrityReport {
  role: 'W01' | 'W02' | 'W03' | 'W04' | 'W05';
  workflowId: string;
  configured: boolean;
  reachable: boolean;
  name: string;
  active: boolean;
  required: boolean;
  nodeCount: number;
  expectedMaxNodes: number;
  webhookPaths: string[];
  hasWebhookAuth: boolean;
  hasLegacyIfSchema: boolean;
  hasDuplicateNodeNames: boolean;
  hasBrokenConnections: boolean;
  hasUnboundPlaceholders: boolean;
  hasDuplicateCanvasSuspected: boolean;
  conflictingActiveWorkflowIds: string[];
  disabledCronTriggers: boolean;
  integrityOk: boolean;
  errors: string[];
  warnings: string[];
}

export interface SyncQueueRecord {
  id: string;
  entity_type: 'POST' | 'MEDIA_ASSET' | 'EXECUTION_LOG' | 'ACCOUNT';
  entity_uuid: string;
  external_id: string;
  operation: 'UPSERT' | 'SOFT_DELETE' | 'DELETE_MEDIA' | 'ARCHIVE';
  payload?: Record<string, unknown>;
  source_revision?: number;
  status: 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'DEAD_LETTER';
  attempts: number;
  max_attempts: number;
  last_error: string;
  next_retry_at: string;
  created_at: string;
  updated_at: string;
}

export interface ReadinessMatrix {
  configurationValid: boolean;
  supabaseReachable: boolean;
  databaseSchemaVerified: boolean;
  atomicRpcTested: boolean;
  rlsVerified: boolean;
  n8nAuthenticated: boolean;
  n8nManagementAuthenticated?: boolean;
  requiredWorkflowsConfigured: boolean;
  workflowIntegrityVerified?: boolean;
  requiredWorkflowsActive?: boolean;
  webhookAuthVerified?: boolean;
  runtimeSettingsAvailable?: boolean;
  livePublishGateEnabled?: boolean;
  liveDeleteGateEnabled?: boolean;
  schedulingGateEnabled?: boolean;
  downloaderAuthVerified: boolean;
  cloudinaryAuthenticated: boolean;
  instagramAuthenticated: boolean;
  sheetsReachable?: boolean;
  n8nEnvAccessOk: boolean;
  n8nDiagnosticStatus?: DiagnosticState;
  lastSuccessfulCheckAt?: string | null;
  readyForExtraction: boolean;
  readyForPublishing: boolean;
  readyForDeletion: boolean;
  readyForScheduling?: boolean;
  workflowReports?: WorkflowIntegrityReport[];
}

export interface StorageSummary {
  configured: boolean;
  cloudName: string;
  totalAssets: number;
  activeAssets: number;
  deletedAssets: number;
  unmanagedAssets: number;
  totalTrackedBytes: number;
  cloudinaryUsage?: {
    storageBytesUsed: number | null;
    bandwidthBytesUsed: number | null;
    creditsUsagePercent: number | null;
    resourcesCount: number | null;
    plan?: string;
  } | null;
}

export interface N8nExecutionSummary {
  id: string;
  workflowId: string;
  workflowName?: string;
  postId?: string;
  operation?: string;
  status: string;
  mode: string;
  startedAt: string;
  stoppedAt?: string | null;
  finished: boolean;
  durationMs?: number | null;
}

export interface N8nExecutionDetail extends N8nExecutionSummary {
  lastNode: string;
  errorMessage: string;
  nodes: Array<{
    name: string;
    attempt: number;
    durationMs: number | null;
    status: string;
    error: string;
  }>;
  reports: Record<string, unknown>;
}

export interface ActionEligibility {
  enabled: boolean;
  reason: string;
}

export interface PostEligibility {
  isLocked: boolean;
  isDuplicateId: boolean;
  isDuplicateSource: boolean;
  isCarousel: boolean;
  extract: ActionEligibility;
  publish: ActionEligibility;
  schedule: ActionEligibility;
  cancelSchedule: ActionEligibility;
  edit: ActionEligibility;
  deleteMedia: ActionEligibility;
  deletePost: ActionEligibility;
  archive: ActionEligibility;
  retry: ActionEligibility;
  reconcile: ActionEligibility;
}

export interface OverviewResponse {
  demo: boolean;
  accountLabel: string;
  igUserId: string;
  timezone: string;
  cloudName: string;
  sheetId: string;
  sheetGid: string;
  flags: {
    schedulingEnabled: boolean;
    bulkPublishEnabled: boolean;
    aiCaptionEnabled: boolean;
    livePublishEnabled: boolean;
    liveDeleteEnabled: boolean;
  };
  stats: {
    totalPosts: number;
    drafts: number;
    ready: number;
    scheduled: number;
    published: number;
    failed: number;
    verifyManually: number;
    activeJobs: number;
    mediaAssetsCount: number;
    syncPendingCount?: number;
    publishSuccessRate: number | null;
    extractSuccessRate: number | null;
  };
  nextScheduledPost: ContentRecord | null;
  lastExtractionAt: string | null;
  lastPublicationAt: string | null;
  connections: ServiceConnectionStatus[];
  storage: StorageSummary;
  posts: ContentRecord[];
  assets: MediaAssetRecord[];
  executions: N8nExecutionSummary[];
  logs: ExecutionLogRecord[];
  jobs: DurableJob[];
  locks: JobLock[];
  syncQueue?: SyncQueueRecord[];
  readiness?: ReadinessMatrix;
  diagnosticsRequestId?: string;
  diagnosticsFromCache?: boolean;
  lastDiagnosticAt?: string;
  cooldown: {
    blocked: boolean;
    until: string | null;
    unknown: boolean;
  };
  now: string;
}
