/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import type { MediaAssetRecord } from '../../types/instaops';
import { ConfirmModal } from '../dialogs/ConfirmModal';
import { formatBytes, StorageStatusBadge } from '../ui/Badges';

export function MediaLibraryView() {
  const { overview, pushToast, deleteSingleAsset } = useInstaOps();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'DELETED' | 'UNMANAGED'>('ACTIVE');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'video' | 'image'>('ALL');
  const [previewAsset, setPreviewAsset] = useState<MediaAssetRecord | null>(null);
  const [confirmAsset, setConfirmAsset] = useState<MediaAssetRecord | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [busy, setBusy] = useState(false);

  const postMap = useMemo(() => {
    const map = new Map<string, { status: string; media_type: string }>();
    for (const p of overview?.posts ?? []) {
      map.set(p.post_id, { status: p.status, media_type: p.media_type });
    }
    return map;
  }, [overview?.posts]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (overview?.assets ?? []).filter((a) => {
      if (statusFilter !== 'ALL' && a.storage_status !== statusFilter) return false;
      if (typeFilter !== 'ALL' && a.resource_type !== typeFilter) return false;
      if (q) {
        const hay = `${a.post_id} ${a.cloudinary_public_id} ${a.internal_asset_id} ${a.format}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [overview?.assets, statusFilter, typeFilter, search]);

  // Unused assets = ACTIVE assets belonging to FAILED, ARCHIVED, MEDIA_DELETED, or DELETED posts
  const unusedCleanupCandidates = useMemo(() => {
    return (overview?.assets ?? []).filter((a) => {
      if (a.storage_status !== 'ACTIVE' || !a.cloudinary_public_id) return false;
      const owner = postMap.get(a.post_id);
      if (!owner) return false;
      return ['FAILED', 'ARCHIVED', 'DELETED', 'MEDIA_DELETED'].includes(owner.status);
    });
  }, [overview?.assets, postMap]);

  const canDeleteLive = overview?.demo || overview?.flags.liveDeleteEnabled;

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ kind: 'success', title: 'URL copied' });
    } catch {
      pushToast({ kind: 'warning', title: 'Clipboard blocked' });
    }
  };

  const handleSingleDelete = async (reason: string) => {
    if (!confirmAsset) return;
    setBusy(true);
    try {
      await deleteSingleAsset(confirmAsset.internal_asset_id, true, reason);
      setConfirmAsset(null);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Asset deletion blocked',
        detail: e instanceof Error ? e.message : 'Unable to delete asset.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleBulkCleanup = async (reason: string) => {
    setBusy(true);
    let okCount = 0;
    let failCount = 0;
    for (const a of unusedCleanupCandidates) {
      try {
        await deleteSingleAsset(a.internal_asset_id, true, reason);
        okCount++;
      } catch {
        failCount++;
      }
    }
    setBusy(false);
    setConfirmBulk(false);
    pushToast({
      kind: failCount > 0 ? 'warning' : 'success',
      title: `Bulk cleanup complete (${okCount} deleted, ${failCount} failed)`,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Media Library (Cloudinary)</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Cloud `{overview?.cloudName ?? 'djkkknb9k'}` · Tracks `public_id` &amp; `asset_id` across Reels, Images, and 9+ slide Carousels.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={!canDeleteLive || unusedCleanupCandidates.length === 0 || busy}
          title={
            !canDeleteLive
              ? 'LIVE_DELETE_ENABLED is false'
              : unusedCleanupCandidates.length === 0
                ? 'No unused active assets from FAILED/ARCHIVED/DELETED posts'
                : 'Delete unused active assets'
          }
          onClick={() => setConfirmBulk(true)}
        >
          Cleanup Unused Assets ({unusedCleanupCandidates.length})
        </button>
      </div>

      {/* Storage KPI Bar */}
      <section className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Active Tracked Assets</span>
          <span className="kpi-value">{overview?.storage.activeAssets ?? 0}</span>
          <span className="kpi-sub">Tracked bytes: {formatBytes(overview?.storage.totalTrackedBytes ?? 0)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Deleted Assets</span>
          <span className="kpi-value">{overview?.storage.deletedAssets ?? 0}</span>
          <span className="kpi-sub">Destroyed via verified public_id</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Legacy / Unmanaged</span>
          <span className="kpi-value">{overview?.storage.unmanagedAssets ?? 0}</span>
          <span className="kpi-sub">Protected from accidental deletion</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cloudinary Plan Usage</span>
          <span className="kpi-value">
            {overview?.storage.cloudinaryUsage?.storageBytesUsed !== null &&
            overview?.storage.cloudinaryUsage?.storageBytesUsed !== undefined
              ? formatBytes(overview.storage.cloudinaryUsage.storageBytesUsed)
              : '—'}
          </span>
          <span className="kpi-sub">
            Credits:{' '}
            {overview?.storage.cloudinaryUsage?.creditsUsagePercent !== null &&
            overview?.storage.cloudinaryUsage?.creditsUsagePercent !== undefined
              ? `${overview.storage.cloudinaryUsage.creditsUsagePercent}%`
              : 'Unavailable'}
          </span>
        </div>
      </section>

      {/* Filters */}
      <section className="panel" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <input
            aria-label="Search media assets"
            className="input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search post ID, public_id, asset ID, format..."
          />
        </div>
        <select
          aria-label="Filter asset storage status"
          className="select"
          style={{ width: 160 }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'ACTIVE' | 'DELETED' | 'UNMANAGED')}
        >
          <option value="ALL">All Statuses</option>
          <option value="ACTIVE">Active Only</option>
          <option value="DELETED">Deleted</option>
          <option value="UNMANAGED">Unmanaged</option>
        </select>
        <select
          aria-label="Filter media resource type"
          className="select"
          style={{ width: 140 }}
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as 'ALL' | 'video' | 'image')}
        >
          <option value="ALL">All Formats</option>
          <option value="video">Videos</option>
          <option value="image">Images</option>
        </select>
      </section>

      {filteredAssets.length === 0 ? (
        <div className="empty-state">No media assets match the current filters.</div>
      ) : (
        <div className="grid-auto">
          {filteredAssets.map((a) => {
            const owner = postMap.get(a.post_id);
            const deletable =
              canDeleteLive &&
              a.storage_status === 'ACTIVE' &&
              Boolean(a.cloudinary_public_id) &&
              owner?.status !== 'PUBLISHING' &&
              owner?.status !== 'PUBLISHED';
            return (
              <article key={a.internal_asset_id} className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                  <Link href={`/create?postId=${encodeURIComponent(a.post_id)}`} className="mono" style={{ fontWeight: 700 }}>
                    {a.post_id} #{a.media_index + 1}
                  </Link>
                  <StorageStatusBadge status={a.storage_status} />
                </div>

                {a.storage_status !== 'DELETED' && a.secure_url ? (
                  a.resource_type === 'video' ? (
                    <video
                      src={a.secure_url}
                      controls
                      preload="metadata"
                      style={{ width: '100%', height: 180, background: '#000', borderRadius: 6 }}
                    />
                  ) : (
                    <img
                      src={a.thumbnail_url || a.secure_url}
                      alt={a.cloudinary_public_id || a.internal_asset_id}
                      style={{ width: '100%', height: 180, objectFit: 'cover', borderRadius: 6, background: '#000' }}
                    />
                  )
                ) : (
                  <div className="empty-state" style={{ padding: 24 }}>
                    Asset deleted from storage
                  </div>
                )}

                <div style={{ fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                  <div>public_id: <span className="mono">{a.cloudinary_public_id || 'UNMANAGED'}</span></div>
                  <div>asset_id: <span className="mono">{a.cloudinary_asset_id || '—'}</span></div>
                  <div>
                    {a.resource_type.toUpperCase()} · {a.format || '—'} · {formatBytes(a.file_size_bytes)} · Post: {owner?.status ?? 'Unknown'}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
                  {a.secure_url && a.storage_status !== 'DELETED' && (
                    <>
                      <button type="button" className="btn btn-sm" onClick={() => setPreviewAsset(a)}>
                        Preview
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => void copyUrl(a.secure_url)}>
                        Copy URL
                      </button>
                      <a href={a.secure_url} target="_blank" rel="noreferrer" className="btn btn-sm">
                        Download
                      </a>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={!deletable || busy}
                    title={
                      !canDeleteLive
                        ? 'LIVE_DELETE_ENABLED=false'
                        : owner?.status === 'PUBLISHED'
                          ? 'Published post media is protected'
                          : !a.cloudinary_public_id
                            ? 'Missing authoritative public_id'
                            : 'Destroy this Cloudinary asset'
                    }
                    onClick={() => setConfirmAsset(a)}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {previewAsset && (
        <div className="modal-backdrop" onClick={() => setPreviewAsset(null)}>
          <div className="modal-card" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <span className="mono">{previewAsset.cloudinary_public_id || previewAsset.internal_asset_id}</span>
              <button type="button" className="btn btn-sm" onClick={() => setPreviewAsset(null)}>
                Close
              </button>
            </div>
            {previewAsset.resource_type === 'video' ? (
              <video src={previewAsset.secure_url} controls autoPlay style={{ width: '100%', maxHeight: '70vh' }} />
            ) : (
              <img
                src={previewAsset.secure_url}
                alt={previewAsset.cloudinary_public_id}
                style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain' }}
              />
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmAsset !== null}
        title={`Destroy Cloudinary Asset ${confirmAsset?.internal_asset_id ?? ''}?`}
        description="This calls Cloudinary Destroy API using verified ownership and marks the asset DELETED."
        confirmLabel="Confirm Destroy Asset"
        danger
        requireReason
        busy={busy}
        details={
          confirmAsset
            ? [
                { label: 'Post ID', value: confirmAsset.post_id },
                { label: 'public_id', value: confirmAsset.cloudinary_public_id },
                { label: 'asset_id', value: confirmAsset.cloudinary_asset_id },
                { label: 'Size', value: formatBytes(confirmAsset.file_size_bytes) },
              ]
            : undefined
        }
        onCancel={() => setConfirmAsset(null)}
        onConfirm={handleSingleDelete}
      />

      <ConfirmModal
        open={confirmBulk}
        title={`Cleanup ${unusedCleanupCandidates.length} Unused Cloudinary Assets?`}
        description="Only active assets owned by FAILED, ARCHIVED, MEDIA_DELETED, or DELETED posts are targeted."
        confirmLabel={`Delete ${unusedCleanupCandidates.length} Assets`}
        danger
        requireReason
        busy={busy}
        onCancel={() => setConfirmBulk(false)}
        onConfirm={handleBulkCleanup}
      />
    </div>
  );
}
