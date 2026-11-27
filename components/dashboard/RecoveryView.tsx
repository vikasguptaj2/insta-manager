'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { evaluatePostEligibility } from '../../lib/domain/posts';
import { formatTimestampInTimezone } from '../../lib/scheduling/calendar';
import type { ContentRecord } from '../../types/instaops';
import { MediaTypeBadge, StatusBadge } from '../ui/Badges';

type ResolutionAction =
  | 'CHECK_EXECUTION'
  | 'MARK_READY'
  | 'MARK_FAILED'
  | 'MARK_PUBLISHED'
  | 'RELEASE_LOCK';

export function RecoveryView() {
  const { overview, retryPost, reconcilePost, flushSheetsSync, pushToast } = useInstaOps();
  const [flushingSync, setFlushingSync] = useState(false);
  const [retryTarget, setRetryTarget] = useState<ContentRecord | null>(null);
  const [reconcileTarget, setReconcileTarget] = useState<ContentRecord | null>(null);
  const [inspected, setInspected] = useState(false);
  const [forceReleaseLock, setForceReleaseLock] = useState(false);
  const [resolution, setResolution] = useState<ResolutionAction>('CHECK_EXECUTION');
  const [publishedId, setPublishedId] = useState('');
  const [publishedUrl, setPublishedUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const timezone = overview?.timezone ?? 'Asia/Kolkata';

  const attentionItems = useMemo(() => {
    if (!overview) return [];
    const canWrite = overview.demo || overview.connections.some((c) => c.id === 'n8n' && c.status !== 'offline');
    return overview.posts
      .filter(
        (p) =>
          p.status === 'FAILED' ||
          p.status === 'VERIFY_MANUALLY' ||
          ['EXTRACTING', 'UPLOADING', 'PUBLISHING', 'DELETING'].includes(p.status) ||
          Boolean(p.container_id && p.status !== 'PUBLISHED'),
      )
      .map((post) => ({
        post,
        eligibility: evaluatePostEligibility(post, {
          rows: overview.posts,
          assets: overview.assets,
          executions: overview.executions,
          canWrite,
          schedulingEnabled: overview.flags.schedulingEnabled,
          livePublishEnabled: overview.flags.livePublishEnabled,
          liveDeleteEnabled: overview.flags.liveDeleteEnabled,
          demoMode: overview.demo,
          cooldown: overview.cooldown,
        }),
      }));
  }, [overview]);

  const unmanagedAssets = useMemo(
    () => (overview?.assets ?? []).filter((a) => a.storage_status === 'UNMANAGED' || !a.cloudinary_public_id),
    [overview?.assets],
  );

  const submitRetry = async () => {
    if (!retryTarget) return;
    setBusy(true);
    try {
      await retryPost(retryTarget.post_id, inspected, forceReleaseLock);
      setRetryTarget(null);
      setInspected(false);
      setForceReleaseLock(false);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Retry blocked',
        detail: e instanceof Error ? e.message : 'Unable to reset failed post.',
      });
    } finally {
      setBusy(false);
    }
  };

  const submitReconcile = async () => {
    if (!reconcileTarget) return;
    setBusy(true);
    try {
      await reconcilePost(reconcileTarget.post_id, {
        inspected,
        resolution,
        published_id: resolution === 'MARK_PUBLISHED' ? publishedId.trim() : undefined,
        published_url: resolution === 'MARK_PUBLISHED' ? publishedUrl.trim() : undefined,
      });
      setReconcileTarget(null);
      setInspected(false);
      setPublishedId('');
      setPublishedUrl('');
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Reconciliation failed',
        detail: e instanceof Error ? e.message : 'Verify inputs and try again.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Error Handling &amp; Recovery</h1>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Categorized failures, unknown-outcome publication reconciliation (`VERIFY_MANUALLY`), stale lock release, and unmanaged asset checks.
        </div>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Posts Requiring Attention ({attentionItems.length})</h2>
          <Link href="/executions" className="btn btn-sm">
            Inspect n8n Executions
          </Link>
        </div>

        {attentionItems.length === 0 ? (
          <div className="empty-state">
            No failed, verification-blocked, or stuck posts. Queue is healthy.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Post</th>
                  <th>Status</th>
                  <th>Error Code / Stage</th>
                  <th>Diagnostic</th>
                  <th>Container / Execution</th>
                  <th>Recovery Actions</th>
                </tr>
              </thead>
              <tbody>
                {attentionItems.map(({ post, eligibility }) => (
                  <tr key={post.post_id}>
                    <td>
                      <div className="mono" style={{ fontWeight: 700 }}>{post.post_id}</div>
                      <MediaTypeBadge type={post.media_type} />
                    </td>
                    <td>
                      <StatusBadge status={post.status} />
                    </td>
                    <td>
                      <div className="mono" style={{ fontSize: 11 }}>{post.error_code || '—'}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{post.error_stage || '—'}</div>
                    </td>
                    <td style={{ maxWidth: 280, fontSize: 12, color: 'var(--status-danger-fg)' }}>
                      {post.error || (post.status === 'VERIFY_MANUALLY' ? 'Publication outcome uncertain — verify before retrying.' : 'In-flight / unresolved container.')}
                    </td>
                    <td style={{ fontSize: 11 }}>
                      <div>container: <span className="mono">{post.container_id || '—'}</span></div>
                      <div>exec: <span className="mono">{post.execution_id || '—'}</span></div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={!eligibility.retry.enabled || busy}
                          title={eligibility.retry.reason || 'Reset failed post after inspection'}
                          onClick={() => {
                            setInspected(false);
                            setForceReleaseLock(false);
                            setRetryTarget(post);
                          }}
                        >
                          Safe Retry
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          disabled={!eligibility.reconcile.enabled || busy}
                          title={eligibility.reconcile.reason || 'Reconcile uncertain outcome'}
                          onClick={() => {
                            setInspected(false);
                            setResolution(post.container_id ? 'CHECK_EXECUTION' : 'MARK_READY');
                            setReconcileTarget(post);
                          }}
                        >
                          Verify / Reconcile
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Active Locks &amp; Unmanaged Media Reconciliation</h2>
        </div>
        <div className="split-2">
          <div>
            <h3 style={{ marginTop: 0, fontSize: 13 }}>Active Locks ({overview?.locks.length ?? 0})</h3>
            {(overview?.locks.length ?? 0) === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Zero active locks in lock store.</div>
            ) : (
              overview?.locks.map((l) => (
                <div
                  key={l.lock_key}
                  style={{
                    padding: 10,
                    border: '1px solid var(--border-default)',
                    borderRadius: 6,
                    marginBottom: 8,
                    fontSize: 12,
                  }}
                >
                  <div className="mono" style={{ fontWeight: 700 }}>{l.lock_key}</div>
                  <div>Op: {l.operation} · Expires: {formatTimestampInTimezone(l.expires_at, timezone)}</div>
                </div>
              ))
            )}
          </div>
          <div>
            <h3 style={{ marginTop: 0, fontSize: 13 }}>Legacy / Unmanaged Assets ({unmanagedAssets.length})</h3>
            {unmanagedAssets.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                All active assets have verified `cloudinary_public_id` &amp; `asset_id` records.
              </div>
            ) : (
              unmanagedAssets.map((a) => (
                <div
                  key={a.internal_asset_id}
                  style={{
                    padding: 10,
                    border: '1px solid var(--border-default)',
                    borderRadius: 6,
                    marginBottom: 8,
                    fontSize: 12,
                  }}
                >
                  <div className="mono">{a.post_id} · {a.internal_asset_id}</div>
                  <div style={{ color: 'var(--text-muted)' }}>Protected legacy media (`{a.storage_status}`)</div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">Google Sheets Outbox Sync Queue ({overview?.syncQueue?.length ?? 0})</h2>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Supabase primary writes never roll back when Google Sheets reporting sync retries.
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            disabled={flushingSync}
            onClick={() => {
              setFlushingSync(true);
              void flushSheetsSync().finally(() => setFlushingSync(false));
            }}
          >
            {flushingSync ? 'Syncing...' : 'Flush Sync Queue'}
          </button>
        </div>
        {(overview?.syncQueue?.length ?? 0) === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            All synchronized records in outbox are clean.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Entity</th>
                  <th>External ID / UUID</th>
                  <th>Op</th>
                  <th>Status</th>
                  <th className="num-col">Attempts</th>
                  <th>Last Error</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.syncQueue ?? []).slice(0, 15).map((s) => (
                  <tr key={s.id}>
                    <td>{s.entity_type}</td>
                    <td>
                      <div className="mono">{s.external_id}</div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{s.entity_uuid}</div>
                    </td>
                    <td>{s.operation}</td>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="num-col">{s.attempts}/{s.max_attempts}</td>
                    <td style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{s.last_error || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Safe Retry Modal */}
      {retryTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Safe Retry — {retryTarget.post_id}</h2>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              Confirm you inspected the execution trace and resolved any transient failure before unlocking this record.
            </p>
            <label style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 10 }}>
              <input type="checkbox" checked={inspected} onChange={(e) => setInspected(e.target.checked)} />
              <span>I inspected the logs/execution state (`inspected: true`).</span>
            </label>
            <label style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={forceReleaseLock}
                onChange={(e) => setForceReleaseLock(e.target.checked)}
              />
              <span>Force release stale lock if present.</span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setRetryTarget(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!inspected || busy}
                onClick={() => void submitRetry()}
              >
                {busy ? 'Resetting...' : 'Reset for Safe Retry'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reconcile Modal */}
      {reconcileTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Reconcile Unknown Outcome — {reconcileTarget.post_id}</h2>
            <div style={{ marginBottom: 12 }}>
              <label htmlFor="reconcile-res-select" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Reconciliation Resolution
              </label>
              <select
                id="reconcile-res-select"
                className="select"
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ResolutionAction)}
              >
                <option value="CHECK_EXECUTION">Check Upstream Execution &amp; Container</option>
                <option value="MARK_PUBLISHED">Confirm Already Published on Instagram (Requires IG Media ID)</option>
                <option value="MARK_FAILED">Mark Failed (Not Published — Safe to Retry Later)</option>
                <option value="MARK_READY">Reset to READY (Verified Safe to Re-run)</option>
                <option value="RELEASE_LOCK">Release Lock &amp; Inspect</option>
              </select>
            </div>

            {resolution === 'MARK_PUBLISHED' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
                <div>
                  <label htmlFor="rec-pub-id" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    Verified Instagram Media ID (required)
                  </label>
                  <input
                    id="rec-pub-id"
                    className="input"
                    value={publishedId}
                    onChange={(e) => setPublishedId(e.target.value)}
                    placeholder="e.g. 18044229100991122"
                  />
                </div>
                <div>
                  <label htmlFor="rec-pub-url" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    Instagram Permalink (optional)
                  </label>
                  <input
                    id="rec-pub-url"
                    className="input"
                    value={publishedUrl}
                    onChange={(e) => setPublishedUrl(e.target.value)}
                    placeholder="https://www.instagram.com/reel/..."
                  />
                </div>
              </div>
            )}

            <label style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 16 }}>
              <input type="checkbox" checked={inspected} onChange={(e) => setInspected(e.target.checked)} />
              <span>I inspected Instagram / Meta container / n8n execution before applying this reconciliation.</span>
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setReconcileTarget(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  !inspected ||
                  busy ||
                  (resolution === 'MARK_PUBLISHED' && !publishedId.trim())
                }
                onClick={() => void submitReconcile()}
              >
                {busy ? 'Applying...' : 'Apply Reconciliation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
