import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { flushSyncQueueToSheets } from '../../lib/service';
import { resetLockStoreForTest } from '../../lib/jobs/lock-store';
import { SupabaseLockStore, SupabaseRepository } from '../../lib/supabase/server';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const ALL_TABLES = [
  'instaops_accounts',
  'instaops_posts',
  'instaops_media_assets',
  'instaops_post_revisions',
  'instaops_jobs',
  'instaops_job_locks',
  'instaops_idempotency_keys',
  'instaops_execution_logs',
  'instaops_sync_queue',
  'instaops_audit_events',
];

describe('Supabase migrations, RLS, constraints, transactional RPCs & outbox sync isolation', () => {
  beforeEach(() => {
    process.env.DEMO_MODE = 'false';
    process.env.SUPABASE_URL = 'https://cdgwdlhesgcxmswsamrj.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-service-role-secret-key';
    process.env.SHEETS_SYNC_ENABLED = 'true';
    process.env.N8N_BASE_URL = 'https://137.23.61.127.sslip.io';
    process.env.N8N_WEBHOOK_SECRET = 'unit-test-webhook-secret-32chars';
    resetLockStoreForTest();
  });

  it('includes ordered SQL migrations and complete consolidated INSTALL_FRESH.sql with strict RLS & security definer locks', () => {
    const migrations = [
      '001_extensions_and_enums.sql',
      '002_core_tables.sql',
      '003_indexes_and_constraints.sql',
      '004_functions_and_locking.sql',
      '005_rls_and_security.sql',
    ];
    for (const file of migrations) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, 'supabase', 'migrations', file)), `Missing migration ${file}`);
    }

    const freshSql = fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'INSTALL_FRESH.sql'), 'utf8');
    for (const table of ALL_TABLES) {
      assert.match(freshSql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, 'i'));
      assert.match(freshSql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
      assert.match(freshSql, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM anon, authenticated`, 'i'));
    }

    // Verify permanent UUID PKs & active shortcode unique partial index
    assert.match(freshSql, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/);
    assert.match(freshSql, /uniq_instaops_posts_active_source_id/);
    assert.match(freshSql, /FOR UPDATE SKIP LOCKED/);
    assert.match(freshSql, /SET search_path = ''/);
    assert.match(freshSql, /REVOKE ALL ON FUNCTION public\.instaops_acquire_lock.*FROM PUBLIC, anon, authenticated/s);
    assert.match(freshSql, /REVOKE ALL ON FUNCTION public\.instaops_soft_delete_post.*FROM PUBLIC, anon, authenticated/s);
  });

  it('executes SupabaseLockStore lock acquisition, conflict rejection, and release via PostgREST RPC', async () => {
    const calls: string[] = [];
    let failConflict = false;

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);

      if (url.includes('/rpc/instaops_verify_health_and_rpc')) {
        return new Response(
          JSON.stringify([{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, active_accounts_count: 1, detail: 'tables=10/10' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rest/v1/instaops_job_locks') && !url.includes('/rpc/')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/rest/v1/instaops_posts')) {
        return new Response(JSON.stringify({ id: '550e8400-e29b-41d4-a716-446655440000' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rpc/instaops_acquire_lock')) {
        return new Response(
          JSON.stringify([
            {
              acquired: !failConflict,
              lock_key: 'post:SB-1',
              post_id: 'SB-1',
              operation: 'PUBLISH',
              owner_id: failConflict ? 'other-owner' : 'owner-1',
              request_id: 'req-1',
              acquired_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/rpc/instaops_release_lock')) {
        return new Response(JSON.stringify(true), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const store = new SupabaseLockStore(mockFetch);
    const lock = await store.acquireLock({
      lock_key: 'post:SB-1',
      post_id: 'SB-1',
      operation: 'PUBLISH',
      owner_id: 'owner-1',
      request_id: 'req-1',
    });
    assert.equal(lock.owner_id, 'owner-1');
    assert.ok(calls.some((c) => c.includes('/rpc/instaops_acquire_lock')));

    failConflict = true;
    await assert.rejects(
      store.acquireLock({
        lock_key: 'post:SB-1',
        post_id: 'SB-1',
        operation: 'PUBLISH',
        owner_id: 'owner-2',
        request_id: 'req-2',
      }),
      /locked/i,
    );

    assert.equal(await store.releaseLock('post:SB-1', 'owner-1'), true);
  });

  it('isolates Google Sheets sync failures via outbox retry tracking without corrupting Supabase primary rows', async () => {
    let updatedSyncStatus = '';
    const queueRow = {
      id: '660e8400-e29b-41d4-a716-446655440011',
      entity_type: 'POST',
      entity_uuid: '550e8400-e29b-41d4-a716-446655440000',
      external_id: 'SB-SYNC-1',
      operation: 'UPSERT',
      payload: { row: { post_id: 'SB-SYNC-1' } },
      status: 'PROCESSING',
      attempts: 1,
      max_attempts: 5,
      last_error: '',
      next_retry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/rpc/instaops_verify_health_and_rpc')) {
        return new Response(
          JSON.stringify([{ schema_ok: true, rls_ok: true, anon_revoked_ok: true, atomic_rpc_ok: true, active_accounts_count: 1, detail: 'tables=10/10' }]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/webhook/instaops-content-v1')) {
        return new Response(JSON.stringify({ ok: false, error: 'Google Sheets quota exceeded' }), { status: 500 });
      }
      if (url.includes('/rpc/instaops_claim_sync_batch')) {
        return new Response(JSON.stringify([queueRow]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/rest/v1/instaops_posts') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body || '{}')) as { sheets_sync_status?: string };
        updatedSyncStatus = body.sheets_sync_status ?? '';
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await flushSyncQueueToSheets(mockFetch);
    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 1);
    assert.equal(updatedSyncStatus, 'FAILED');

    const health = await new SupabaseRepository(mockFetch).checkHealth();
    assert.equal(health.ok, true);
  });
});
