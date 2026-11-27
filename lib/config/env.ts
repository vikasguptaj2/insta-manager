export interface AppConfig {
  appName: string;
  timezone: string;
  appUrl: string;
  demoMode: boolean;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  n8nBaseUrl: string;
  n8nApiKey: string;
  n8nWebhookSecret: string;
  workflows: {
    extractId: string;
    publishId: string;
    scheduleId: string;
    contentId: string;
    recoveryId: string;
    extractPath: string;
    publishPath: string;
    contentPath: string;
    recoveryPath: string;
  };
  downloaderBaseUrl: string;
  downloaderApiKey: string;
  instagramAccountLabel: string;
  instagramUserId: string;
  instagramGraphVersion: string;
  sheetsSyncEnabled: boolean;
  googleSheetId: string;
  googleSheetGid: string;
  sheetsTabs: {
    main: string;
    assets: string;
    logs: string;
    accounts: string;
  };
  cloudinaryCloudName: string;
  atomicLockProvider: 'supabase' | 'postgres' | 'local';
  databaseUrl: string;
  flags: {
    schedulingEnabled: boolean;
    bulkPublishEnabled: boolean;
    aiCaptionEnabled: boolean;
    livePublishEnabled: boolean;
    liveDeleteEnabled: boolean;
    publicAccessEnabled: boolean;
  };
}

function readBool(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val === '') return fallback;
  return val.trim().toLowerCase() === 'true';
}

function trimUrl(val: string | undefined, fallback: string): string {
  const raw = (val ?? fallback).trim();
  return raw.replace(/\/+$/, '');
}

/** Load validated server-only configuration from environment variables. */
export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const atomicProviderRaw = (env.ATOMIC_LOCK_PROVIDER ?? 'supabase').trim().toLowerCase();
  const atomicLockProvider: 'supabase' | 'postgres' | 'local' =
    atomicProviderRaw === 'local'
      ? 'local'
      : atomicProviderRaw === 'postgres'
        ? 'postgres'
        : 'supabase';

  return {
    appName: (env.APP_NAME ?? 'InstaOps').trim() || 'InstaOps',
    timezone: (env.APP_TIMEZONE ?? 'Asia/Kolkata').trim() || 'Asia/Kolkata',
    appUrl: trimUrl(env.APP_URL, 'http://127.0.0.1:3000'),
    demoMode: readBool(env.DEMO_MODE, false),
    supabaseUrl: trimUrl(env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL, 'https://cdgwdlhesgcxmswsamrj.supabase.co'),
    supabaseAnonKey: (env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim(),
    supabaseServiceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
    n8nBaseUrl: trimUrl(env.N8N_BASE_URL, 'https://137.23.61.127.sslip.io'),
    n8nApiKey: (env.N8N_API_KEY ?? '').trim(),
    n8nWebhookSecret: (env.N8N_WEBHOOK_SECRET ?? '').trim(),
    workflows: {
      extractId: (env.N8N_EXTRACT_WORKFLOW_ID ?? '').trim(),
      publishId: (env.N8N_PUBLISH_WORKFLOW_ID ?? '').trim(),
      scheduleId: (env.N8N_SCHEDULE_WORKFLOW_ID ?? '').trim(),
      contentId: (env.N8N_CONTENT_WORKFLOW_ID ?? '').trim(),
      recoveryId: (env.N8N_RECOVERY_WORKFLOW_ID ?? '').trim(),
      extractPath: (env.N8N_EXTRACT_PATH ?? 'instaops-extract-v1').trim(),
      publishPath: (env.N8N_PUBLISH_PATH ?? 'instaops-publish-v1').trim(),
      contentPath: (env.N8N_CONTENT_PATH ?? 'instaops-content-v1').trim(),
      recoveryPath: (env.N8N_RECOVERY_PATH ?? 'instaops-recovery-v1').trim(),
    },
    downloaderBaseUrl: trimUrl(env.DOWNLOADER_BASE_URL, 'https://ig-dowloader-nnnn.vercel.app'),
    downloaderApiKey: (env.DOWNLOADER_API_KEY ?? '').trim(),
    instagramAccountLabel: (env.INSTAGRAM_ACCOUNT_LABEL ?? '@vikas.sphere').trim() || '@vikas.sphere',
    instagramUserId: (env.INSTAGRAM_USER_ID ?? '17841453414532595').trim() || '17841453414532595',
    instagramGraphVersion: (env.INSTAGRAM_GRAPH_VERSION ?? 'v22.0').trim() || 'v22.0',
    sheetsSyncEnabled: readBool(env.SHEETS_SYNC_ENABLED, true),
    googleSheetId: (env.GOOGLE_SHEET_ID ?? '19kurWKXLoijsf29tKzedhRHbbg7g9qiSZkcjUszHRhs').trim(),
    googleSheetGid: (env.GOOGLE_SHEET_GID ?? '18819980').trim(),
    sheetsTabs: {
      main: (env.GOOGLE_SHEET_MAIN_TAB ?? 'Posts').trim() || 'Posts',
      assets: (env.GOOGLE_SHEET_ASSETS_TAB ?? 'MediaAssets').trim() || 'MediaAssets',
      logs: (env.GOOGLE_SHEET_LOGS_TAB ?? 'ExecutionLogs').trim() || 'ExecutionLogs',
      accounts: (env.GOOGLE_SHEET_ACCOUNTS_TAB ?? 'Accounts').trim() || 'Accounts',
    },
    cloudinaryCloudName: (env.CLOUDINARY_CLOUD_NAME ?? 'djkkknb9k').trim() || 'djkkknb9k',
    atomicLockProvider,
    databaseUrl: (env.DATABASE_URL ?? '').trim(),
    flags: {
      schedulingEnabled: readBool(env.SCHEDULING_ENABLED, false),
      bulkPublishEnabled: readBool(env.BULK_PUBLISH_ENABLED, false),
      aiCaptionEnabled: readBool(env.AI_CAPTION_ENABLED, false),
      livePublishEnabled: readBool(env.LIVE_PUBLISH_ENABLED, false),
      liveDeleteEnabled: readBool(env.LIVE_DELETE_ENABLED, false),
      publicAccessEnabled: readBool(env.PUBLIC_ACCESS_ENABLED, false),
    },
  };
}

export interface ConfigValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: {
    demoMode: boolean;
    supabaseUrl: string;
    hasSupabaseAnonKey: boolean;
    hasSupabaseServiceRole: boolean;
    sheetsSyncEnabled: boolean;
    n8nBaseUrl: string;
    downloaderBaseUrl: string;
    atomicLockProvider: string;
    hasDatabaseUrl: boolean;
    hasN8nApiKey: boolean;
    hasN8nWebhookSecret: boolean;
    hasDownloaderApiKey: boolean;
    configuredWorkflows: number;
    livePublishEnabled: boolean;
    liveDeleteEnabled: boolean;
  };
}

const KNOWN_LEGACY_WORKFLOW_IDS = new Set([
  'qLQFvHZthHCG1dcU',
  '0ma9ONqTpdlUhJ8j',
  'zLmbbNHZIih9X3Hz',
]);

/** Validate configuration safety and completeness without exposing secrets. */
export function validateConfig(cfg: AppConfig = getConfig()): ConfigValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [label, urlVal] of [
    ['SUPABASE_URL', cfg.supabaseUrl],
    ['N8N_BASE_URL', cfg.n8nBaseUrl],
    ['DOWNLOADER_BASE_URL', cfg.downloaderBaseUrl],
    ['APP_URL', cfg.appUrl],
  ] as const) {
    try {
      const parsed = new URL(urlVal);
      if (label !== 'APP_URL' && parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
        errors.push(`${label} must use HTTPS for remote hosts.`);
      }
    } catch {
      errors.push(`${label} is not a valid URL.`);
    }
  }

  if (cfg.flags.bulkPublishEnabled) {
    errors.push('BULK_PUBLISH_ENABLED must remain false; targeted single-post publishing only.');
  }

  if (cfg.flags.publicAccessEnabled) {
    errors.push('PUBLIC_ACCESS_ENABLED cannot be enabled without configured session authentication.');
  }

  if (!/^\d{8,}$/.test(cfg.instagramUserId)) {
    errors.push('INSTAGRAM_USER_ID must be a numeric Instagram Business/Creator ID string.');
  }

  for (const [k, wid] of [
    ['N8N_EXTRACT_WORKFLOW_ID', cfg.workflows.extractId],
    ['N8N_PUBLISH_WORKFLOW_ID', cfg.workflows.publishId],
    ['N8N_SCHEDULE_WORKFLOW_ID', cfg.workflows.scheduleId],
    ['N8N_CONTENT_WORKFLOW_ID', cfg.workflows.contentId],
    ['N8N_RECOVERY_WORKFLOW_ID', cfg.workflows.recoveryId],
  ] as const) {
    if (wid && KNOWN_LEGACY_WORKFLOW_IDS.has(wid)) {
      errors.push(`${k} references a legacy local Docker workflow ID (${wid}). Import v2 workflows on the online n8n instance and assign fresh IDs.`);
    }
  }

  const hasDurableCoord = Boolean((cfg.supabaseUrl && cfg.supabaseServiceRoleKey) || cfg.databaseUrl);

  if (!cfg.demoMode) {
    if (!cfg.supabaseServiceRoleKey) warnings.push('SUPABASE_SERVICE_ROLE_KEY is empty; Supabase primary DB reads/writes are unavailable.');
    if (!cfg.supabaseAnonKey) warnings.push('SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY is empty.');
    if (!cfg.n8nApiKey) warnings.push('N8N_API_KEY is empty; online n8n management is offline.');
    if (!cfg.n8nWebhookSecret) warnings.push('N8N_WEBHOOK_SECRET is empty; workflow webhook calls are blocked.');
    if (!cfg.downloaderApiKey) warnings.push('DOWNLOADER_API_KEY is empty; direct downloader health auth checks are unconfigured.');
    if (!cfg.workflows.contentId) warnings.push('N8N_CONTENT_WORKFLOW_ID is not set.');
    if (!cfg.workflows.extractId) warnings.push('N8N_EXTRACT_WORKFLOW_ID is not set.');
    if (!cfg.workflows.publishId) warnings.push('N8N_PUBLISH_WORKFLOW_ID is not set.');
    if (!cfg.workflows.recoveryId) warnings.push('N8N_RECOVERY_WORKFLOW_ID is not set.');
  }

  if (cfg.flags.livePublishEnabled && !hasDurableCoord) {
    errors.push('LIVE_PUBLISH_ENABLED requires Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or Postgres DATABASE_URL.');
  }
  if (cfg.flags.liveDeleteEnabled && !hasDurableCoord) {
    errors.push('LIVE_DELETE_ENABLED requires Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or Postgres DATABASE_URL.');
  }
  if (!hasDurableCoord && !cfg.demoMode) {
    warnings.push('No durable lock backend configured (SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL); live publish/delete remain gated.');
  }

  const configuredWorkflows = [
    cfg.workflows.extractId,
    cfg.workflows.publishId,
    cfg.workflows.scheduleId,
    cfg.workflows.contentId,
    cfg.workflows.recoveryId,
  ].filter(Boolean).length;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      demoMode: cfg.demoMode,
      supabaseUrl: cfg.supabaseUrl,
      hasSupabaseAnonKey: Boolean(cfg.supabaseAnonKey),
      hasSupabaseServiceRole: Boolean(cfg.supabaseServiceRoleKey),
      sheetsSyncEnabled: cfg.sheetsSyncEnabled,
      n8nBaseUrl: cfg.n8nBaseUrl,
      downloaderBaseUrl: cfg.downloaderBaseUrl,
      atomicLockProvider: cfg.atomicLockProvider,
      hasDatabaseUrl: Boolean(cfg.databaseUrl),
      hasN8nApiKey: Boolean(cfg.n8nApiKey),
      hasN8nWebhookSecret: Boolean(cfg.n8nWebhookSecret),
      hasDownloaderApiKey: Boolean(cfg.downloaderApiKey),
      configuredWorkflows,
      livePublishEnabled: cfg.flags.livePublishEnabled,
      liveDeleteEnabled: cfg.flags.liveDeleteEnabled,
    },
  };
}
