import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LocalLockStore, createJobRecord } from '../../lib/jobs/lock-store';
import { assertVerifiedWorkflowExport, type WorkflowJson } from '../../lib/n8n/workflow-safety';

describe('n8n workflow export safety verification & LocalLockStore locking', () => {
  it('validates all 5 exported n8n workflows against strict safeguard checks', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const workflows: Array<['W01' | 'W02' | 'W03' | 'W04' | 'W05', string]> = [
      ['W01', 'n8n/workflows/01-extract-upload.json'],
      ['W02', 'n8n/workflows/02-publish-content.json'],
      ['W03', 'n8n/workflows/03-scheduled-runner.json'],
      ['W04', 'n8n/workflows/04-content-management.json'],
      ['W05', 'n8n/workflows/05-recovery-reconciliation.json'],
    ];

    for (const [role, rel] of workflows) {
      const wf = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf8')) as WorkflowJson;
      assert.doesNotThrow(() => assertVerifiedWorkflowExport(role, wf));
    }
  });

  it('enforces mutual exclusion locks, owner release, and idempotency claims', async () => {
    const store = new LocalLockStore(null);
    await store.acquireLock({
      lock_key: 'post:IG-LOCK-1',
      post_id: 'IG-LOCK-1',
      operation: 'PUBLISH',
      owner_id: 'owner-A',
      request_id: 'req-A',
      leaseSeconds: 60,
    });

    await assert.rejects(
      store.acquireLock({
        lock_key: 'post:IG-LOCK-1',
        post_id: 'IG-LOCK-1',
        operation: 'PUBLISH',
        owner_id: 'owner-B',
        request_id: 'req-B',
      }),
      /locked/i,
    );

    // Non-owner cannot release lock
    assert.equal(await store.releaseLock('post:IG-LOCK-1', 'owner-B'), false);
    // Owner releases lock
    assert.equal(await store.releaseLock('post:IG-LOCK-1', 'owner-A'), true);

    const claim1 = await store.claimIdempotency('pub:IG-LOCK-1:1', 'hash1');
    assert.equal(claim1.claimed, true);
    const claim2 = await store.claimIdempotency('pub:IG-LOCK-1:1', 'hash1');
    assert.equal(claim2.claimed, false);

    const job = createJobRecord({
      job_id: 'job_1',
      request_id: 'req-1',
      execution_id: 'ex-1',
      post_id: 'IG-LOCK-1',
      operation: 'PUBLISH',
    });
    await store.saveJob(job);
    assert.equal((await store.getJob('job_1'))?.post_id, 'IG-LOCK-1');
  });
});
