/* eslint-disable @next/next/no-img-element */
'use client';

import Link from 'next/link';
import React, { useEffect, useMemo, useState } from 'react';
import { useInstaOps, type PostDetailBundle } from '../../hooks/use-instaops';
import { evaluatePostEligibility } from '../../lib/domain/posts';
import { formatTimestampInTimezone, localDateTimeInputToUtcIso } from '../../lib/scheduling/calendar';
import type { ContentRecord, PostEligibility } from '../../types/instaops';
import { ConfirmModal } from '../dialogs/ConfirmModal';
import { formatBytes, MediaTypeBadge, StatusBadge } from '../ui/Badges';

const QUEUE_TABS = [
  'ALL',
  'DRAFT',
  'EXTRACTING',
  'READY',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'FAILED',
  'VERIFY_MANUALLY',
  'MEDIA_DELETED',
  'ARCHIVED',
] as const;

export function ContentTable() {
  const {
    overview,
    pushToast,
    patchPost,
    extractPost,
    publishPost,
    schedulePost,
    cancelSchedule,
    archivePost,
    deletePostMedia,
    deletePostAndMedia,
    fetchPostDetail,
  } = useInstaOps();

  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [mediaFilter, setMediaFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'publish_at'>('updated');
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const [drawerPostId, setDrawerPostId] = useState<string | null>(null);
  const [drawerDetail, setDrawerDetail] = useState<PostDetailBundle | null>(null);
  const [captionEdit, setCaptionEdit] = useState('');
  const [scheduleInput, setScheduleInput] = useState('');
  const [busy, setBusy] = useState(false);

  const [confirmState, setConfirmState] = useState<{
    mode: 'publish' | 'schedule' | 'deleteMedia' | 'deletePost';
    post: ContentRecord;
  } | null>(null);

  const timezone = overview?.timezone ?? 'Asia/Kolkata';

  useEffect(() => {
    if (!drawerPostId) return;
    let cancelled = false;
    void fetchPostDetail(drawerPostId)
      .then((bundle) => {
        if (cancelled) return;
        setDrawerDetail(bundle);
        setCaptionEdit(bundle.post.caption || bundle.post.original_caption || '');
      })
      .catch(() => {
        if (!cancelled) setDrawerDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [drawerPostId, overview?.now, fetchPostDetail]);

  const activeDrawerDetail =
    drawerPostId && drawerDetail?.post.post_id === drawerPostId ? drawerDetail : null;

  const rowsWithEligibility = useMemo(() => {
    if (!overview) return [];
    const canWrite = overview.demo || overview.connections.some((c) => c.id === 'n8n' && c.status !== 'offline');
    return overview.posts
      .filter((p) => p.status !== 'DELETED' || statusFilter === 'DELETED')
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
  }, [overview, statusFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out = rowsWithEligibility.filter(({ post }) => {
      if (statusFilter !== 'ALL' && post.status !== statusFilter) return false;
      if (mediaFilter !== 'ALL' && post.media_type !== mediaFilter) return false;
      if (q) {
        const hay = `${post.post_id} ${post.source_id} ${post.source_username} ${post.caption} ${post.original_caption}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    out.sort((a, b) => {
      const valA =
        sortBy === 'publish_at'
          ? a.post.publish_at || ''
          : sortBy === 'created'
            ? a.post.created_at || ''
            : a.post.updated_at || a.post.processed_at || a.post.created_at || '';
      const valB =
        sortBy === 'publish_at'
          ? b.post.publish_at || ''
          : sortBy === 'created'
            ? b.post.created_at || ''
            : b.post.updated_at || b.post.processed_at || b.post.created_at || '';
      return Date.parse(valB || '0') - Date.parse(valA || '0');
    });
    return out;
  }, [rowsWithEligibility, statusFilter, mediaFilter, search, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  const runDirectAction = async (fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) pushToast({ kind: 'success', title: okMsg });
      if (drawerPostId) {
        const b = await fetchPostDetail(drawerPostId).catch(() => null);
        if (b) setDrawerDetail(b);
      }
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Action blocked',
        detail: e instanceof Error ? e.message : 'Unable to execute action.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmModal = async (reason: string) => {
    if (!confirmState) return;
    setBusy(true);
    const { mode, post } = confirmState;
    try {
      if (mode === 'publish') {
        await publishPost(post.post_id, {
          confirm: true,
          reviewedRevision: post.revision,
          caption: drawerPostId === post.post_id ? captionEdit : post.caption || post.original_caption,
        });
      } else if (mode === 'schedule') {
        const utcIso = localDateTimeInputToUtcIso(scheduleInput, timezone);
        await schedulePost(post.post_id, {
          confirm: true,
          reviewedRevision: post.revision,
          publish_at: utcIso,
          caption: drawerPostId === post.post_id ? captionEdit : post.caption || post.original_caption,
        });
      } else if (mode === 'deleteMedia') {
        await deletePostMedia(post.post_id, true, reason);
      } else if (mode === 'deletePost') {
        await deletePostAndMedia(post.post_id, true, reason);
        if (drawerPostId === post.post_id) setDrawerPostId(null);
      }
      setConfirmState(null);
      if (mode !== 'deletePost' && drawerPostId) {
        const b = await fetchPostDetail(drawerPostId).catch(() => null);
        if (b) setDrawerDetail(b);
      }
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Confirmation failed',
        detail: e instanceof Error ? e.message : 'Check errors and retry.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Content Queue</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Inspect, edit captions, extract media, schedule, archive, or delete with full audit guardrails.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : ''}`}
            onClick={() => setViewMode('table')}
          >
            Table View
          </button>
          <button
            type="button"
            className={`btn btn-sm ${viewMode === 'cards' ? 'btn-primary' : ''}`}
            onClick={() => setViewMode('cards')}
          >
            Cards View
          </button>
          <Link href="/create" className="btn btn-primary btn-sm">
            + New Draft
          </Link>
        </div>
      </div>

      {/* Status Tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {QUEUE_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`btn btn-sm ${statusFilter === tab ? 'btn-primary' : ''}`}
            onClick={() => {
              setStatusFilter(tab);
              setPage(1);
            }}
          >
            {tab.replaceAll('_', ' ')}
          </button>
        ))}
      </div>

      {/* Filters Bar */}
      <section className="panel" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <input
            aria-label="Search queue"
            className="input"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search post ID, shortcode, creator, or caption..."
          />
        </div>
        <select
          aria-label="Filter by media type"
          className="select"
          style={{ width: 150 }}
          value={mediaFilter}
          onChange={(e) => {
            setMediaFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="ALL">All Types</option>
          <option value="REEL">Reels</option>
          <option value="IMAGE">Images</option>
          <option value="CAROUSEL">Carousels</option>
        </select>
        <select
          aria-label="Sort posts"
          className="select"
          style={{ width: 170 }}
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'updated' | 'created' | 'publish_at')}
        >
          <option value="updated">Sort: Last Updated</option>
          <option value="publish_at">Sort: Schedule Date</option>
          <option value="created">Sort: Created Date</option>
        </select>
      </section>

      {paginated.length === 0 ? (
        <div className="empty-state">No queue items match your current filter.</div>
      ) : viewMode === 'table' ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Post</th>
                <th>Type</th>
                <th>Status</th>
                <th>Caption</th>
                <th>Schedule / Published ({timezone})</th>
                <th className="num-col">Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {paginated.map(({ post, eligibility }) => (
                <tr key={post.post_id}>
                  <td>
                    <div className="mono" style={{ fontWeight: 700 }}>{post.post_id}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {post.source_username || post.source_id || '—'} · rev {post.revision}
                    </div>
                  </td>
                  <td>
                    <MediaTypeBadge type={post.media_type} />
                  </td>
                  <td>
                    <StatusBadge status={post.status} />
                    {post.error_code && (
                      <div style={{ fontSize: 10, color: 'var(--status-danger-fg)', marginTop: 2 }}>
                        {post.error_code}
                      </div>
                    )}
                  </td>
                  <td style={{ maxWidth: 280 }}>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {post.caption || post.original_caption || (
                        <span style={{ color: 'var(--text-muted)' }}>No caption</span>
                      )}
                    </div>
                  </td>
                  <td className="tabular" style={{ fontSize: 12 }}>
                    {post.published_at
                      ? formatTimestampInTimezone(post.published_at, timezone)
                      : post.publish_at
                        ? formatTimestampInTimezone(post.publish_at, timezone)
                        : '—'}
                  </td>
                  <td className="num-col">{formatBytes(post.file_size_bytes)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-sm" onClick={() => setDrawerPostId(post.post_id)}>
                        Inspect
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={!eligibility.extract.enabled || busy}
                        title={eligibility.extract.reason || 'Extract media'}
                        onClick={() => void runDirectAction(() => extractPost(post.post_id, true), 'Extraction queued')}
                      >
                        Extract
                      </button>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={!eligibility.publish.enabled || busy}
                        title={eligibility.publish.reason || 'Publish reviewed post'}
                        onClick={() => setConfirmState({ mode: 'publish', post })}
                      >
                        Publish
                      </button>
                      {post.status === 'SCHEDULED' && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={!eligibility.cancelSchedule.enabled || busy}
                          onClick={() =>
                            void runDirectAction(() => cancelSchedule(post.post_id), 'Schedule cancelled')
                          }
                        >
                          Unschedule
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="grid-auto">
          {paginated.map(({ post, eligibility }) => (
            <article key={post.post_id} className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="mono" style={{ fontWeight: 700 }}>{post.post_id}</span>
                <StatusBadge status={post.status} />
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <MediaTypeBadge type={post.media_type} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {post.source_username || post.source_id} · {formatBytes(post.file_size_bytes)}
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', minHeight: 36 }}>
                {(post.caption || post.original_caption || '(No caption)').slice(0, 120)}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
                <button type="button" className="btn btn-sm" onClick={() => setDrawerPostId(post.post_id)}>
                  Details
                </button>
                <Link href={`/create?postId=${encodeURIComponent(post.post_id)}`} className="btn btn-sm">
                  Studio
                </Link>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!eligibility.publish.enabled || busy}
                  title={eligibility.publish.reason}
                  onClick={() => setConfirmState({ mode: 'publish', post })}
                >
                  Publish
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)' }}>
          Showing {paginated.length} of {filtered.length} matching records
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Prev
          </button>
          <span className="tabular">
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      </div>

      {/* Inspect & Edit Drawer */}
      {activeDrawerDetail && (
        <DrawerInspector
          detail={activeDrawerDetail}
          timezone={timezone}
          captionEdit={captionEdit}
          setCaptionEdit={setCaptionEdit}
          scheduleInput={scheduleInput}
          setScheduleInput={setScheduleInput}
          busy={busy}
          onClose={() => setDrawerPostId(null)}
          onSaveCaption={() =>
            void runDirectAction(
              () => patchPost(activeDrawerDetail.post.post_id, { caption: captionEdit }),
              'Caption updated',
            )
          }
          onArchive={() =>
            void runDirectAction(() => archivePost(activeDrawerDetail.post.post_id), 'Post archived')
          }
          onOpenConfirm={(mode) => setConfirmState({ mode, post: activeDrawerDetail.post })}
        />
      )}

      <ConfirmModal
        open={confirmState !== null}
        title={
          confirmState?.mode === 'publish'
            ? `Publish ${confirmState.post.post_id}?`
            : confirmState?.mode === 'schedule'
              ? `Schedule ${confirmState.post.post_id}?`
              : confirmState?.mode === 'deleteMedia'
                ? `Delete stored media for ${confirmState?.post.post_id ?? ''}?`
                : `Delete post & media for ${confirmState?.post.post_id ?? ''}?`
        }
        description="Review the target IDs and confirm explicitly before invoking backend state changes."
        confirmLabel={confirmState?.mode === 'deletePost' ? 'Delete Post & Media' : 'Confirm'}
        danger={confirmState?.mode === 'deleteMedia' || confirmState?.mode === 'deletePost'}
        requireReason={confirmState?.mode === 'deleteMedia' || confirmState?.mode === 'deletePost'}
        busy={busy}
        details={
          confirmState
            ? [
                { label: 'Post ID', value: confirmState.post.post_id },
                { label: 'Revision', value: confirmState.post.revision },
                { label: 'Status', value: confirmState.post.status },
              ]
            : undefined
        }
        onCancel={() => setConfirmState(null)}
        onConfirm={handleConfirmModal}
      />
    </div>
  );
}

function DrawerInspector({
  detail,
  timezone,
  captionEdit,
  setCaptionEdit,
  scheduleInput,
  setScheduleInput,
  busy,
  onClose,
  onSaveCaption,
  onArchive,
  onOpenConfirm,
}: {
  detail: PostDetailBundle;
  timezone: string;
  captionEdit: string;
  setCaptionEdit: (v: string) => void;
  scheduleInput: string;
  setScheduleInput: (v: string) => void;
  busy: boolean;
  onClose: () => void;
  onSaveCaption: () => void;
  onArchive: () => void;
  onOpenConfirm: (mode: 'publish' | 'schedule' | 'deleteMedia' | 'deletePost') => void;
}) {
  const { post, assets, eligibility } = detail;
  const activeAssets = assets.filter((a) => a.storage_status === 'ACTIVE');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <aside
        className="drawer-card"
        role="dialog"
        aria-modal="true"
        aria-label={`Inspect ${post.post_id}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            <div className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{post.post_id}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <MediaTypeBadge type={post.media_type} />
              <StatusBadge status={post.status} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Link href={`/create?postId=${encodeURIComponent(post.post_id)}`} className="btn btn-sm">
              Open Studio
            </Link>
            <button type="button" className="btn btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {activeAssets.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
              {activeAssets.map((a) =>
                a.resource_type === 'video' ? (
                  <video
                    key={a.internal_asset_id}
                    src={a.secure_url}
                    controls
                    style={{ width: '100%', height: 140, background: '#000', borderRadius: 6 }}
                  />
                ) : (
                  <img
                    key={a.internal_asset_id}
                    src={a.secure_url}
                    alt={a.cloudinary_public_id}
                    style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 6 }}
                  />
                ),
              )}
            </div>
          )}

          <div>
            <label htmlFor="drawer-caption" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              Final Editable Caption
            </label>
            <textarea
              id="drawer-caption"
              className="textarea"
              rows={4}
              value={captionEdit}
              disabled={!eligibility.edit.enabled}
              onChange={(e) => setCaptionEdit(e.target.value)}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Updated: {formatTimestampInTimezone(post.updated_at, timezone)}
              </span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!eligibility.edit.enabled || busy}
                onClick={onSaveCaption}
              >
                Save Caption
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="drawer-schedule" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Schedule ({timezone})
              </label>
              <input
                id="drawer-schedule"
                type="datetime-local"
                className="input"
                value={scheduleInput}
                onChange={(e) => setScheduleInput(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!eligibility.schedule.enabled || !scheduleInput || busy}
              title={eligibility.schedule.reason}
              onClick={() => onOpenConfirm('schedule')}
            >
              Schedule
            </button>
          </div>

          <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!eligibility.publish.enabled || busy}
              title={eligibility.publish.reason}
              onClick={() => onOpenConfirm('publish')}
            >
              Publish Now
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!eligibility.archive.enabled || busy}
              title={eligibility.archive.reason}
              onClick={onArchive}
            >
              Archive
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={!eligibility.deleteMedia.enabled || busy}
              title={eligibility.deleteMedia.reason}
              onClick={() => onOpenConfirm('deleteMedia')}
            >
              Delete Media
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={!eligibility.deletePost.enabled || busy}
              title={eligibility.deletePost.reason}
              onClick={() => onOpenConfirm('deletePost')}
            >
              Delete Post
            </button>
          </div>

          <ReasonChecklist eligibility={eligibility} />
        </div>
      </aside>
    </div>
  );
}

function ReasonChecklist({ eligibility }: { eligibility: PostEligibility }) {
  const blocked = [
    { name: 'Extract', e: eligibility.extract },
    { name: 'Publish', e: eligibility.publish },
    { name: 'Schedule', e: eligibility.schedule },
    { name: 'Edit', e: eligibility.edit },
    { name: 'Delete Media', e: eligibility.deleteMedia },
    { name: 'Delete Post', e: eligibility.deletePost },
  ].filter((x) => !x.e.enabled && x.e.reason);

  if (blocked.length === 0) return null;

  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-subtle)', padding: 10, borderRadius: 6 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Safety Guardrails Active</div>
      {blocked.map((b) => (
        <div key={b.name}>
          <strong>{b.name}:</strong> {b.e.reason}
        </div>
      ))}
    </div>
  );
}
