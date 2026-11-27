/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { formatTimestampInTimezone } from '../../lib/scheduling/calendar';
import { MediaTypeBadge, StatusBadge, StorageStatusBadge } from '../ui/Badges';

export function PublishedView() {
  const { overview, archivePost, pushToast } = useInstaOps();
  const [busyId, setBusyId] = useState<string | null>(null);
  const timezone = overview?.timezone ?? 'Asia/Kolkata';

  const publishedRows = useMemo(() => {
    return (overview?.posts ?? [])
      .filter((p) => p.status === 'PUBLISHED')
      .sort((a, b) => Date.parse(b.published_at || b.processed_at || '0') - Date.parse(a.published_at || a.processed_at || '0'));
  }, [overview?.posts]);

  const assetsByPost = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of overview?.assets ?? []) {
      if (!map.has(a.post_id)) map.set(a.post_id, a.storage_status);
    }
    return map;
  }, [overview?.assets]);

  const handleArchive = async (postId: string) => {
    setBusyId(postId);
    try {
      await archivePost(postId);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Archive failed',
        detail: e instanceof Error ? e.message : 'Unable to archive post.',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Published Posts</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Verified live publications with Meta Graph API `published_id`, permalink, execution reference, and asset status.
          </div>
        </div>
        <Link href="/create" className="btn btn-primary btn-sm">
          + Open Post Studio
        </Link>
      </div>

      {publishedRows.length === 0 ? (
        <div className="empty-state">
          No published posts recorded yet. Trigger Click 2 (Publish Now) in Post Studio after media &amp; caption review.
        </div>
      ) : (
        <div className="grid-auto">
          {publishedRows.map((p) => {
            const storageStatus = assetsByPost.get(p.post_id) ?? 'UNMANAGED';
            return (
              <article key={p.post_id} className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="mono" style={{ fontWeight: 700 }}>{p.post_id}</span>
                  <StatusBadge status={p.status} />
                </div>

                {p.media_url &&
                  (p.media_type === 'REEL' ? (
                    <video
                      src={p.media_url}
                      controls
                      preload="metadata"
                      style={{ width: '100%', height: 190, background: '#000', borderRadius: 6 }}
                    />
                  ) : (
                    <img
                      src={p.media_url}
                      alt={p.post_id}
                      style={{ width: '100%', height: 190, objectFit: 'cover', borderRadius: 6, background: '#000' }}
                    />
                  ))}

                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <MediaTypeBadge type={p.media_type} />
                  <StorageStatusBadge status={storageStatus} />
                </div>

                <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {(p.caption || p.original_caption || '(empty caption)').slice(0, 150)}
                </div>

                <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'grid', gap: 2 }}>
                  <div>IG Media ID: <span className="mono">{p.published_id || '—'}</span></div>
                  <div>Execution: <span className="mono">{p.execution_id || '—'}</span></div>
                  <div>Published ({timezone}): {formatTimestampInTimezone(p.published_at || p.processed_at, timezone)}</div>
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
                  {p.published_url && (
                    <a href={p.published_url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
                      View on Instagram
                    </a>
                  )}
                  <Link href={`/create?postId=${encodeURIComponent(p.post_id)}`} className="btn btn-sm">
                    Inspect
                  </Link>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === p.post_id}
                    onClick={() => void handleArchive(p.post_id)}
                  >
                    {busyId === p.post_id ? 'Archiving...' : 'Archive'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
