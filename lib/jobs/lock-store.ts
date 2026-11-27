import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import type { DurableJob, JobLock, JobOperation, JobStage } from '../../types/instaops';
import { AppError } from '../errors/codes';
import { getConfig } from '../config/env';

export interface LockAcquireInput {
  lock_key: string;
  post_uuid?: string;
  post_id: string;
  operation: JobOperation;
  owner_id: string;
  request_id: string;
  leaseSeconds?: number;
}

export interface IdempotencyClaimResult<T = unknown> {
  claimed: boolean;
  existingState?: string;
  existingResponse?: T;
}

export interface LockStore {
  readonly mode: 'supabase' | 'postgres' | 'local';
  ensureSchema(): Promise<void>;
  acquireLock(input: LockAcquireInput): Promise<JobLock>;
  transferOrClaimLock(input: LockAcquireInput & { expectedOwner?: string }): Promise<JobLock>;
  renewLock(lockKey: string, ownerId: string, leaseSeconds?: number): Promise<{ renewed: boolean; expires_at?: string }>;
  releaseLock(lockKey: string, ownerId: string): Promise<boolean>;
  listActiveLocks(): Promise<JobLock[]>;
  releaseStaleLocks(nowIso?: string): Promise<number>;
  claimIdempotency<T = unknown>(
    key: string,
    requestHash: string,
    ttlSeconds?: number,
  ): Promise<IdempotencyClaimResult<T>>;
  completeIdempotency(key: string, status: 'SUCCEEDED' | 'FAILED', response: unknown): Promise<void>;
  saveJob(job: DurableJob): Promise<DurableJob>;
  getJob(jobId: string): Promise<DurableJob | null>;
  listJobs(limit?: number): Promise<DurableJob[]>;
  close(): Promise<void>;
}

/**
 * Dedicated PostgreSQL schema (instaops_v2) atomic lock, durable job, and idempotency store.
 * Uses INSERT ... ON CONFLICT DO UPDATE WHERE expires_at < NOW() without touching n8n's own tables.
 */
export class PostgresLockStore implements LockStore {
  readonly mode = 'postgres' as const;
  private readonly pool: Pool;
  private schemaReady = false;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10_000 });
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS instaops_v2;
      CREATE TABLE IF NOT EXISTS instaops_v2.job_locks (
        lock_key TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS instaops_v2.jobs (
        job_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        execution_id TEXT NOT NULL DEFAULT '',
        post_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS instaops_v2.idempotency_keys (
        idem_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        response_json JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
    this.schemaReady = true;
  }

  async acquireLock(input: LockAcquireInput): Promise<JobLock> {
    await this.ensureSchema();
    const leaseSec = Math.max(15, Math.min(3600, input.leaseSeconds ?? 300));
    const res = await this.pool.query(
      `
      INSERT INTO instaops_v2.job_locks (lock_key, post_id, operation, owner_id, request_id, acquired_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + ($6::text || ' seconds')::interval)
      ON CONFLICT (lock_key) DO UPDATE
        SET post_id = EXCLUDED.post_id,
            operation = EXCLUDED.operation,
            owner_id = EXCLUDED.owner_id,
            request_id = EXCLUDED.request_id,
            acquired_at = NOW(),
            expires_at = EXCLUDED.expires_at
      WHERE instaops_v2.job_locks.expires_at < NOW()
      RETURNING lock_key, post_id, operation, owner_id, request_id, acquired_at::text, expires_at::text;
      `,
      [input.lock_key, input.post_id, input.operation, input.owner_id, input.request_id, leaseSec],
    );
    const row = res.rows[0] as JobLock | undefined;
    if (!row) {
      throw new AppError('POST_LOCKED', `Post ${input.post_id} is locked by another active workflow.`, {
        httpStatus: 409,
        details: { lock_key: input.lock_key },
      });
    }
    return row;
  }

  async transferOrClaimLock(input: LockAcquireInput & { expectedOwner?: string }): Promise<JobLock> {
    await this.ensureSchema();
    const leaseSec = Math.max(15, Math.min(3600, input.leaseSeconds ?? 300));
    const expectedOwner = (input.expectedOwner ?? '').trim();
    const res = await this.pool.query(
      `
      INSERT INTO instaops_v2.job_locks (lock_key, post_id, operation, owner_id, request_id, acquired_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + ($6::text || ' seconds')::interval)
      ON CONFLICT (lock_key) DO UPDATE
        SET post_id = EXCLUDED.post_id,
            operation = EXCLUDED.operation,
            owner_id = EXCLUDED.owner_id,
            request_id = EXCLUDED.request_id,
            expires_at = EXCLUDED.expires_at
      WHERE instaops_v2.job_locks.expires_at < NOW()
         OR instaops_v2.job_locks.owner_id = EXCLUDED.owner_id
         OR ($7 <> '' AND instaops_v2.job_locks.owner_id = $7)
      RETURNING lock_key, post_id, operation, owner_id, request_id, acquired_at::text, expires_at::text;
      `,
      [input.lock_key, input.post_id, input.operation, input.owner_id, input.request_id, leaseSec, expectedOwner],
    );
    const row = res.rows[0] as JobLock | undefined;
    if (!row) {
      throw new AppError('POST_LOCKED', `Lock transfer failed for ${input.post_id}: active owner mismatch.`, {
        httpStatus: 409,
        details: { lock_key: input.lock_key },
      });
    }
    return row;
  }

  async renewLock(lockKey: string, ownerId: string, leaseSeconds = 300): Promise<{ renewed: boolean; expires_at?: string }> {
    await this.ensureSchema();
    const leaseSec = Math.max(15, Math.min(3600, leaseSeconds));
    const res = await this.pool.query(
      `UPDATE instaops_v2.job_locks SET expires_at = NOW() + ($3::text || ' seconds')::interval WHERE lock_key = $1 AND owner_id = $2 AND expires_at >= NOW() RETURNING expires_at::text;`,
      [lockKey, ownerId, leaseSec],
    );
    const row = res.rows[0] as { expires_at?: string } | undefined;
    return row ? { renewed: true, expires_at: row.expires_at } : { renewed: false };
  }

  async releaseLock(lockKey: string, ownerId: string): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `DELETE FROM instaops_v2.job_locks WHERE lock_key = $1 AND owner_id = $2 RETURNING lock_key;`,
      [lockKey, ownerId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async listActiveLocks(): Promise<JobLock[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT lock_key, post_id, operation, owner_id, request_id, acquired_at::text, expires_at::text
       FROM instaops_v2.job_locks WHERE expires_at >= NOW() ORDER BY acquired_at DESC;`,
    );
    return res.rows as JobLock[];
  }

  async releaseStaleLocks(): Promise<number> {
    await this.ensureSchema();
    const res = await this.pool.query(`DELETE FROM instaops_v2.job_locks WHERE expires_at < NOW();`);
    return res.rowCount ?? 0;
  }

  async claimIdempotency<T = unknown>(
    key: string,
    requestHash: string,
    ttlSeconds = 7 * 86400,
  ): Promise<IdempotencyClaimResult<T>> {
    await this.ensureSchema();
    const ins = await this.pool.query(
      `
      INSERT INTO instaops_v2.idempotency_keys (idem_key, request_hash, state, created_at, expires_at)
      VALUES ($1, $2, 'IN_PROGRESS', NOW(), NOW() + ($3::text || ' seconds')::interval)
      ON CONFLICT (idem_key) DO NOTHING
      RETURNING idem_key;
      `,
      [key, requestHash, ttlSeconds],
    );
    if ((ins.rowCount ?? 0) > 0) return { claimed: true };

    const existing = await this.pool.query(
      `SELECT request_hash, state, response_json FROM instaops_v2.idempotency_keys WHERE idem_key = $1;`,
      [key],
    );
    const row = existing.rows[0] as
      | { request_hash: string; state: string; response_json: T }
      | undefined;
    if (!row) return { claimed: true };
    if (row.request_hash !== requestHash) {
      throw new AppError(
        'REVISION_CONFLICT',
        'Idempotency key reused with a different request payload.',
        { httpStatus: 422 },
      );
    }
    return {
      claimed: false,
      existingState: row.state,
      existingResponse: row.response_json,
    };
  }

  async completeIdempotency(key: string, status: 'SUCCEEDED' | 'FAILED', response: unknown): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE instaops_v2.idempotency_keys SET state = $2, response_json = $3::jsonb WHERE idem_key = $1;`,
      [key, status, JSON.stringify(response ?? {})],
    );
  }

  async saveJob(job: DurableJob): Promise<DurableJob> {
    await this.ensureSchema();
    await this.pool.query(
      `
      INSERT INTO instaops_v2.jobs (job_id, request_id, execution_id, post_id, operation, stage, status, error_code, error_message, created_at, updated_at, finished_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (job_id) DO UPDATE SET
        execution_id = EXCLUDED.execution_id,
        stage = EXCLUDED.stage,
        status = EXCLUDED.status,
        error_code = EXCLUDED.error_code,
        error_message = EXCLUDED.error_message,
        updated_at = EXCLUDED.updated_at,
        finished_at = EXCLUDED.finished_at;
      `,
      [
        job.job_id,
        job.request_id,
        job.execution_id,
        job.post_id,
        job.operation,
        job.stage,
        job.status,
        job.error_code ?? null,
        job.error_message ?? null,
        job.created_at,
        job.updated_at,
        job.finished_at ?? null,
      ],
    );
    return job;
  }

  async getJob(jobId: string): Promise<DurableJob | null> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT job_id, request_id, execution_id, post_id, operation, stage, status, error_code, error_message,
              created_at::text, updated_at::text, finished_at::text
       FROM instaops_v2.jobs WHERE job_id = $1;`,
      [jobId],
    );
    return (res.rows[0] as DurableJob | undefined) ?? null;
  }

  async listJobs(limit = 50): Promise<DurableJob[]> {
    await this.ensureSchema();
    const res = await this.pool.query(
      `SELECT job_id, request_id, execution_id, post_id, operation, stage, status, error_code, error_message,
              created_at::text, updated_at::text, finished_at::text
       FROM instaops_v2.jobs ORDER BY created_at DESC LIMIT $1;`,
      [limit],
    );
    return res.rows as DurableJob[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Local persistent file + memory store for single-process tests and DEMO_MODE previews. */
export class LocalLockStore implements LockStore {
  readonly mode = 'local' as const;
  private locks = new Map<string, JobLock>();
  private idempotency = new Map<string, { requestHash: string; state: string; response: unknown }>();
  private jobs = new Map<string, DurableJob>();
  private readonly dir: string | null;

  constructor(persistDir?: string | null) {
    this.dir = persistDir ?? null;
  }

  async ensureSchema(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(path.join(this.dir, 'jobs-state.json'), 'utf8');
      const parsed = JSON.parse(raw) as { jobs?: DurableJob[]; locks?: JobLock[] };
      for (const j of parsed.jobs ?? []) this.jobs.set(j.job_id, j);
      for (const l of parsed.locks ?? []) this.locks.set(l.lock_key, l);
    } catch {
      // ignore missing file on fresh start
    }
  }

  private async persist(): Promise<void> {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, 'jobs-state.json.tmp');
    const target = path.join(this.dir, 'jobs-state.json');
    await fs.writeFile(
      tmp,
      JSON.stringify({
        jobs: Array.from(this.jobs.values()).slice(0, 200),
        locks: Array.from(this.locks.values()),
      }),
      { mode: 0o600 },
    );
    await fs.rename(tmp, target);
  }

  async acquireLock(input: LockAcquireInput): Promise<JobLock> {
    await this.ensureSchema();
    const existing = this.locks.get(input.lock_key);
    const nowMs = Date.now();
    if (existing && Date.parse(existing.expires_at) > nowMs) {
      throw new AppError('POST_LOCKED', `Post ${input.post_id} is locked by active job (${existing.operation}).`, {
        httpStatus: 409,
        details: { owner_id: existing.owner_id, expires_at: existing.expires_at },
      });
    }
    const leaseSec = Math.max(15, Math.min(3600, input.leaseSeconds ?? 300));
    const lock: JobLock = {
      lock_key: input.lock_key,
      post_uuid: input.post_uuid,
      post_id: input.post_id,
      operation: input.operation,
      owner_id: input.owner_id,
      request_id: input.request_id,
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + leaseSec * 1000).toISOString(),
    };
    this.locks.set(input.lock_key, lock);
    await this.persist();
    return lock;
  }

  async transferOrClaimLock(input: LockAcquireInput & { expectedOwner?: string }): Promise<JobLock> {
    await this.ensureSchema();
    const existing = this.locks.get(input.lock_key);
    const nowMs = Date.now();
    const expectedOwner = (input.expectedOwner ?? '').trim();
    if (
      existing &&
      Date.parse(existing.expires_at) > nowMs &&
      existing.owner_id !== input.owner_id &&
      (!expectedOwner || existing.owner_id !== expectedOwner)
    ) {
      throw new AppError('POST_LOCKED', `Lock transfer rejected for ${input.post_id}: held by ${existing.owner_id}.`, {
        httpStatus: 409,
        details: { owner_id: existing.owner_id, expires_at: existing.expires_at },
      });
    }
    const leaseSec = Math.max(15, Math.min(3600, input.leaseSeconds ?? 300));
    const lock: JobLock = {
      lock_key: input.lock_key,
      post_uuid: input.post_uuid ?? existing?.post_uuid,
      post_id: input.post_id,
      operation: input.operation,
      owner_id: input.owner_id,
      request_id: input.request_id,
      acquired_at: existing?.acquired_at ?? new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + leaseSec * 1000).toISOString(),
    };
    this.locks.set(input.lock_key, lock);
    await this.persist();
    return lock;
  }

  async renewLock(lockKey: string, ownerId: string, leaseSeconds = 300): Promise<{ renewed: boolean; expires_at?: string }> {
    const existing = this.locks.get(lockKey);
    const nowMs = Date.now();
    if (!existing || existing.owner_id !== ownerId || Date.parse(existing.expires_at) < nowMs) return { renewed: false };
    const leaseSec = Math.max(15, Math.min(3600, leaseSeconds));
    const expires_at = new Date(nowMs + leaseSec * 1000).toISOString();
    this.locks.set(lockKey, { ...existing, expires_at });
    await this.persist();
    return { renewed: true, expires_at };
  }

  async releaseLock(lockKey: string, ownerId: string): Promise<boolean> {
    const existing = this.locks.get(lockKey);
    if (!existing || existing.owner_id !== ownerId) return false;
    this.locks.delete(lockKey);
    await this.persist();
    return true;
  }

  async listActiveLocks(nowMs = Date.now()): Promise<JobLock[]> {
    return Array.from(this.locks.values()).filter((l) => Date.parse(l.expires_at) >= nowMs);
  }

  async releaseStaleLocks(nowIso = new Date().toISOString()): Promise<number> {
    const nowMs = Date.parse(nowIso);
    let released = 0;
    for (const [k, v] of this.locks.entries()) {
      if (Date.parse(v.expires_at) < nowMs) {
        this.locks.delete(k);
        released++;
      }
    }
    if (released > 0) await this.persist();
    return released;
  }

  async claimIdempotency<T = unknown>(key: string, requestHash: string): Promise<IdempotencyClaimResult<T>> {
    const existing = this.idempotency.get(key);
    if (!existing) {
      this.idempotency.set(key, { requestHash, state: 'IN_PROGRESS', response: undefined });
      return { claimed: true };
    }
    if (existing.requestHash !== requestHash) {
      throw new AppError('REVISION_CONFLICT', 'Idempotency key reused with different payload.', {
        httpStatus: 422,
      });
    }
    return {
      claimed: false,
      existingState: existing.state,
      existingResponse: existing.response as T,
    };
  }

  async completeIdempotency(key: string, status: 'SUCCEEDED' | 'FAILED', response: unknown): Promise<void> {
    const existing = this.idempotency.get(key);
    if (!existing) return;
    this.idempotency.set(key, { ...existing, state: status, response });
  }

  async saveJob(job: DurableJob): Promise<DurableJob> {
    this.jobs.set(job.job_id, job);
    await this.persist();
    return job;
  }

  async getJob(jobId: string): Promise<DurableJob | null> {
    await this.ensureSchema();
    return this.jobs.get(jobId) ?? null;
  }

  async listJobs(limit = 50): Promise<DurableJob[]> {
    await this.ensureSchema();
    return Array.from(this.jobs.values())
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit);
  }

  async close(): Promise<void> {
    // no-op for local store
  }
}

let singletonStore: LockStore | null = null;

export function getLockStore(): LockStore {
  const cfg = getConfig();
  if (singletonStore) return singletonStore;
  if (!cfg.demoMode && cfg.atomicLockProvider === 'supabase' && cfg.supabaseUrl && cfg.supabaseServiceRoleKey) {
    // Load dynamically to keep client bundle tree-shaking clean and prevent circular top-level imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SupabaseLockStore } = require('../supabase/server') as typeof import('../supabase/server');
    singletonStore = new SupabaseLockStore();
  } else if (!cfg.demoMode && cfg.databaseUrl) {
    singletonStore = new PostgresLockStore(cfg.databaseUrl);
  } else {
    singletonStore = new LocalLockStore(
      cfg.demoMode ? null : path.join(process.cwd(), '.local-data'),
    );
  }
  return singletonStore;
}

export function resetLockStoreForTest(custom?: LockStore | null): void {
  singletonStore = custom ?? null;
}

export function createJobRecord(params: {
  job_id: string;
  request_id: string;
  execution_id?: string;
  post_id: string;
  operation: JobOperation;
  stage?: JobStage;
}): DurableJob {
  const now = new Date().toISOString();
  return {
    job_id: params.job_id,
    request_id: params.request_id,
    execution_id: params.execution_id ?? '',
    post_id: params.post_id,
    operation: params.operation,
    stage: params.stage ?? 'QUEUED',
    status: 'QUEUED',
    created_at: now,
    updated_at: now,
  };
}
