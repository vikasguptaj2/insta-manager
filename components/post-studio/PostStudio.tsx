/* eslint-disable @next/next/no-img-element */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useInstaOps, type PostDetailBundle } from '../../hooks/use-instaops';
import {
  CaptionStatusBadge,
  formatBytes,
  MediaTypeBadge,
  StatusBadge,
  StorageStatusBadge,
} from '../ui/Badges';
import { ConfirmModal } from '../dialogs/ConfirmModal';
import {
  computePostProgress,
  parseHashtagsAndMentions,
} from '../../lib/domain/posts';
import {
  formatTimestampInTimezone,
  localDateTimeInputToUtcIso,
  utcIsoToLocalDateTimeInput,
} from '../../lib/scheduling/calendar';

export function PostStudio({ initialPostId }: { initialPostId?: string }) {
  const {
    overview,
    pushToast,
    activeJobs,
    createPost,
    patchPost,
    extractPost,
    publishPost,
    schedulePost,
    deletePostMedia,
    deletePostAndMedia,
    fetchPostDetail,
  } = useInstaOps();

  const [selectedPostId, setSelectedPostId] = useState<string>(initialPostId ?? '');
  const [detail, setDetail] = useState<PostDetailBundle | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // New Draft Form State
  const [newUrl, setNewUrl] = useState('');
  const [newMediaHint, setNewMediaHint] = useState<'REEL' | 'IMAGE' | 'CAROUSEL'>('REEL');
  const [newPostId, setNewPostId] = useState('');
  const [authorized, setAuthorized] = useState(false);

  // Selected Post Editable State
  const [captionDraft, setCaptionDraft] = useState('');
  const [allowEmptyCaption, setAllowEmptyCaption] = useState(false);
  const [sourceUrlDraft, setSourceUrlDraft] = useState('');
  const [scheduleInput, setScheduleInput] = useState('');
  const [carouselIdx, setCarouselIdx] = useState(0);

  // Modal State
  const [modalMode, setModalMode] = useState<'publish' | 'schedule' | 'deleteMedia' | 'deletePost' | null>(null);

  const visiblePosts = useMemo(
    () => (overview?.posts ?? []).filter((p) => p.status !== 'DELETED'),
    [overview?.posts],
  );

  const effectivePostId = selectedPostId || visiblePosts[0]?.post_id || '';

  // Fetch rich post detail whenever selection or overview refreshes
  useEffect(() => {
    if (!effectivePostId) return;
    let cancelled = false;
    void fetchPostDetail(effectivePostId)
      .then((bundle) => {
        if (cancelled) return;
        setDetail(bundle);
        setCaptionDraft(bundle.post.caption || bundle.post.original_caption || '');
        setSourceUrlDraft(bundle.post.source_instagram_url || '');
        setScheduleInput(
          bundle.post.publish_at
            ? utcIsoToLocalDateTimeInput(bundle.post.publish_at, overview?.timezone ?? 'Asia/Kolkata')
            : '',
        );
        setCarouselIdx(0);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [effectivePostId, overview?.now, overview?.timezone, fetchPostDetail]);

  const activeDetail = effectivePostId && detail?.post.post_id === effectivePostId ? detail : null;
  const currentPost = activeDetail?.post ?? null;
  const currentAssets = useMemo(
    () => (activeDetail?.assets ?? []).filter((a) => a.storage_status !== 'DELETED').sort((a, b) => a.media_index - b.media_index),
    [activeDetail?.assets],
  );
  const eligibility = activeDetail?.eligibility ?? null;
  const timezone = overview?.timezone ?? 'Asia/Kolkata';

  const parsedTags = useMemo(() => parseHashtagsAndMentions(captionDraft), [captionDraft]);
  const progress = useMemo(() => (currentPost ? computePostProgress(currentPost) : null), [currentPost]);
  const runningJobForPost = useMemo(
    () => activeJobs.find((j) => j.post_id === currentPost?.post_id) ?? null,
    [activeJobs, currentPost?.post_id],
  );

  const copyText = async (val: string, label: string) => {
    try {
      await navigator.clipboard.writeText(val);
      pushToast({ kind: 'success', title: `${label} copied to clipboard` });
    } catch {
      pushToast({ kind: 'warning', title: 'Clipboard blocked', detail: 'Copy manually from the field.' });
    }
  };

  const handlePasteUrl = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setNewUrl(clip.trim());
    } catch {
      pushToast({ kind: 'warning', title: 'Clipboard read denied', detail: 'Paste URL manually using Ctrl+V.' });
    }
  };

  const handleCreate = async (andExtract: boolean) => {
    setBusyAction(andExtract ? 'createExtract' : 'create');
    try {
      const created = await createPost({
        post_id: newPostId.trim() || undefined,
        source_instagram_url: newUrl.trim(),
        media_type: newMediaHint,
        authorized,
      });
      setSelectedPostId(created.post_id);
      setNewUrl('');
      setNewPostId('');
      if (andExtract) {
        await extractPost(created.post_id, true);
      }
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Failed to create draft',
        detail: e instanceof Error ? e.message : 'Check input and try again.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveChanges = async () => {
    if (!currentPost) return;
    setBusyAction('save');
    try {
      const patchPayload: {
        caption?: string;
        allowEmptyCaption?: boolean;
        source_instagram_url?: string;
      } = {
        caption: captionDraft,
        allowEmptyCaption,
      };
      if (sourceUrlDraft.trim() !== currentPost.source_instagram_url) {
        patchPayload.source_instagram_url = sourceUrlDraft.trim();
      }
      const updated = await patchPost(currentPost.post_id, patchPayload);
      const bundle = await fetchPostDetail(updated.post_id);
      setDetail(bundle);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Save rejected',
        detail: e instanceof Error ? e.message : 'Could not update post.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleExtractClick = async () => {
    if (!currentPost) return;
    setBusyAction('extract');
    try {
      await extractPost(currentPost.post_id, true);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Extraction rejected',
        detail: e instanceof Error ? e.message : 'Could not start extraction.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleModalConfirm = async (reason: string) => {
    if (!currentPost || !modalMode) return;
    setBusyAction(modalMode);
    try {
      if (modalMode === 'publish') {
        await publishPost(currentPost.post_id, {
          confirm: true,
          reviewedRevision: currentPost.revision,
          caption: captionDraft,
          allowEmptyCaption,
        });
      } else if (modalMode === 'schedule') {
        const utcIso = localDateTimeInputToUtcIso(scheduleInput, timezone);
        await schedulePost(currentPost.post_id, {
          confirm: true,
          reviewedRevision: currentPost.revision,
          publish_at: utcIso,
          caption: captionDraft,
          allowEmptyCaption,
        });
      } else if (modalMode === 'deleteMedia') {
        await deletePostMedia(currentPost.post_id, true, reason);
      } else if (modalMode === 'deletePost') {
        await deletePostAndMedia(currentPost.post_id, true, reason);
        setSelectedPostId('');
      }
      setModalMode(null);
      if (modalMode !== 'deletePost') {
        const bundle = await fetchPostDetail(currentPost.post_id).catch(() => null);
        if (bundle) setDetail(bundle);
      }
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Action failed',
        detail: e instanceof Error ? e.message : 'Operation could not complete.',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const activeAsset = currentAssets[carouselIdx] ?? currentAssets[0] ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Post Studio</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Two-stage review workflow: Click 1 extracts &amp; stores media in Cloudinary (`DRAFT`). Click 2 publishes after caption review.
          </div>
        </div>
        <div style={{ minWidth: 280 }}>
          <label htmlFor="studio-post-select" className="kpi-label" style={{ display: 'block', marginBottom: 4 }}>
            Active Record
          </label>
          <select
            id="studio-post-select"
            className="select"
            value={effectivePostId}
            onChange={(e) => setSelectedPostId(e.target.value)}
          >
            <option value="">-- Select post --</option>
            {visiblePosts.map((p) => (
              <option key={p.post_id} value={p.post_id}>
                {p.post_id} · {p.media_type} · {p.status}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Create New Content Card */}
      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Add Instagram URL to Queue</h2>
          <span className="badge badge-info">Step 1 creates DRAFT only — never auto-publishes</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 10 }}>
          <div>
            <label htmlFor="new-ig-url" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              Instagram Post / Reel URL
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                id="new-ig-url"
                className="input"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://www.instagram.com/reel/C8xYzExample/"
              />
              <button type="button" className="btn" onClick={() => void handlePasteUrl()}>
                Paste
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="new-media-hint" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              Expected Type
            </label>
            <select
              id="new-media-hint"
              className="select"
              value={newMediaHint}
              onChange={(e) => setNewMediaHint(e.target.value as 'REEL' | 'IMAGE' | 'CAROUSEL')}
            >
              <option value="REEL">REEL (Video)</option>
              <option value="IMAGE">IMAGE</option>
              <option value="CAROUSEL">CAROUSEL (2-10 mixed items)</option>
            </select>
          </div>

          <div>
            <label htmlFor="new-post-id" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
              Custom Post ID (optional)
            </label>
            <input
              id="new-post-id"
              className="input"
              value={newPostId}
              onChange={(e) => setNewPostId(e.target.value)}
              placeholder="Auto-generated if empty"
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12, flexWrap: 'wrap', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
            <span>I confirm I own or have explicit authorization to extract and repost this content.</span>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn"
              disabled={!newUrl.trim() || !authorized || busyAction !== null}
              onClick={() => void handleCreate(false)}
            >
              {busyAction === 'create' ? 'Saving...' : 'Save Draft Only'}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!newUrl.trim() || !authorized || busyAction !== null}
              onClick={() => void handleCreate(true)}
            >
              {busyAction === 'createExtract' ? 'Starting...' : 'Create & Extract Media'}
            </button>
          </div>
        </div>
      </section>

      {!currentPost ? (
        <div className="empty-state">Select a post above or create a new draft to inspect media and edit captions.</div>
      ) : (
        <div className="split-2">
          {/* LEFT COLUMN: EXTRACTION & STORED MEDIA PREVIEW */}
          <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="panel-header" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontWeight: 700, fontSize: 14 }}>
                  {currentPost.post_id}
                </span>
                {currentPost.id && (
                  <span className="mono badge badge-neutral" title={`Permanent UUID: ${currentPost.id}`}>
                    uuid:{currentPost.id.slice(0, 8)}
                  </span>
                )}
                <MediaTypeBadge type={currentPost.media_type} />
                <StatusBadge status={currentPost.status} />
                {currentPost.sheets_sync_status && (
                  <span className="badge badge-neutral" title="Google Sheets Reporting Sync Status">
                    Sheets: {currentPost.sheets_sync_status}
                  </span>
                )}
                <span className="badge badge-neutral">rev {currentPost.revision}</span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!eligibility?.extract.enabled || busyAction !== null}
                title={eligibility?.extract.reason || 'Extract source media and store on Cloudinary'}
                onClick={() => void handleExtractClick()}
              >
                {busyAction === 'extract' ? 'Queueing...' : currentPost.media_url ? 'Re-Extract Media' : 'Click 1: Extract & Upload'}
              </button>
            </div>

            {!eligibility?.extract.enabled && eligibility?.extract.reason && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Extract disabled: {eligibility.extract.reason}
              </div>
            )}

            {runningJobForPost && (
              <div className="banner banner-info">
                <span>
                  Active Job <span className="mono">{runningJobForPost.job_id}</span>: {runningJobForPost.operation} ·{' '}
                  <strong>{runningJobForPost.stage}</strong>
                </span>
              </div>
            )}

            {currentPost.media_type === 'CAROUSEL' && (
              <div className="banner banner-info">
                <span>
                  <strong>Multi-Asset Carousel Ready ({currentAssets.length} item{currentAssets.length === 1 ? '' : 's'}):</strong>{' '}
                  Meta Graph API v22.0 publishes mixed Images &amp; Videos (2–10 items) cleanly using sequential child containers and parent CAROUSEL container.
                </span>
              </div>
            )}

            {/* Progress indicator */}
            {progress && (
              <div style={{ background: 'var(--bg-subtle)', padding: 10, borderRadius: 6, border: '1px solid var(--border-default)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  <span>Workflow Readiness</span>
                  <span>{progress.label}</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${(progress.completed / progress.total) * 100}%` }} />
                </div>
              </div>
            )}

            {/* Source URL Editor (editable only if no stored media) */}
            <div>
              <label htmlFor="studio-source-url" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Source Instagram URL
              </label>
              <input
                id="studio-source-url"
                className="input"
                value={sourceUrlDraft}
                disabled={Boolean(currentPost.media_url) || !eligibility?.edit.enabled}
                onChange={(e) => setSourceUrlDraft(e.target.value)}
              />
              {currentPost.media_url && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                  Source URL locked once Cloudinary media is stored. Delete media first if changing URL.
                </div>
              )}
            </div>

            {/* Media Player / Gallery Preview */}
            <div
              style={{
                border: '1px solid var(--border-default)',
                borderRadius: 8,
                background: 'var(--bg-subtle)',
                padding: 12,
              }}
            >
              {activeAsset || currentPost.media_url ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {currentAssets.length > 1
                        ? `Slide ${carouselIdx + 1} of ${currentAssets.length}`
                        : 'Cloudinary Stored Media'}
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {activeAsset && <StorageStatusBadge status={activeAsset.storage_status} />}
                      <a
                        href={activeAsset?.secure_url || currentPost.media_url}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-sm"
                      >
                        Open Raw
                      </a>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void copyText(activeAsset?.secure_url || currentPost.media_url, 'Cloudinary URL')}
                      >
                        Copy URL
                      </button>
                    </div>
                  </div>

                  {(activeAsset ? activeAsset.resource_type === 'video' : currentPost.media_type === 'REEL') ? (
                    <video
                      key={activeAsset?.secure_url || currentPost.media_url}
                      src={activeAsset?.secure_url || currentPost.media_url}
                      controls
                      playsInline
                      preload="metadata"
                      style={{ width: '100%', maxHeight: 420, borderRadius: 6, background: '#000' }}
                    />
                  ) : (
                    <img
                      src={activeAsset?.secure_url || currentPost.media_url}
                      alt={`Stored media for ${currentPost.post_id}`}
                      style={{ width: '100%', maxHeight: 420, objectFit: 'contain', borderRadius: 6, background: '#000' }}
                    />
                  )}

                  {currentAssets.length > 1 && (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={carouselIdx <= 0}
                        onClick={() => setCarouselIdx((i) => Math.max(0, i - 1))}
                      >
                        Prev Slide
                      </button>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
                        {currentAssets.map((a, idx) => (
                          <button
                            key={a.internal_asset_id}
                            type="button"
                            className={`btn btn-sm ${idx === carouselIdx ? 'btn-primary' : ''}`}
                            onClick={() => setCarouselIdx(idx)}
                          >
                            #{idx + 1}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={carouselIdx >= currentAssets.length - 1}
                        onClick={() => setCarouselIdx((i) => Math.min(currentAssets.length - 1, i + 1))}
                      >
                        Next Slide
                      </button>
                    </div>
                  )}

                  {activeAsset && (
                    <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)', display: 'grid', gap: 3 }}>
                      <div>
                        public_id: <span className="mono">{activeAsset.cloudinary_public_id || 'UNMANAGED'}</span>
                      </div>
                      <div>
                        Format: {activeAsset.format || '—'} · Size: {formatBytes(activeAsset.file_size_bytes)} · Dimensions:{' '}
                        {activeAsset.width ?? '?'}×{activeAsset.height ?? '?'}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-state">
                  No stored Cloudinary media yet. Click <strong>Extract &amp; Upload</strong> above to fetch media from Instagram.
                </div>
              )}
            </div>
          </section>

          {/* RIGHT COLUMN: CAPTIONS, METADATA, REVIEW & PUBLISH */}
          <section className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Original Extracted Caption */}
            <div style={{ padding: 12, borderRadius: 6, background: 'var(--bg-subtle)', border: '1px solid var(--border-default)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>Original Extracted Caption</span>
                  <CaptionStatusBadge status={currentPost.caption_status} />
                </div>
                {currentPost.original_caption && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!eligibility?.edit.enabled}
                    onClick={() => setCaptionDraft(currentPost.original_caption)}
                  >
                    Copy to Editable
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>
                {currentPost.original_caption
                  ? currentPost.original_caption
                  : currentPost.caption_status === 'empty'
                    ? 'Source post had an empty caption.'
                    : currentPost.caption_status === 'unavailable'
                      ? 'Caption could not be extracted by the upstream source resolver.'
                      : 'Extract source media to inspect the original caption.'}
              </div>
            </div>

            {/* Editable Final Caption */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <label htmlFor="studio-caption-editor" style={{ fontSize: 12, fontWeight: 600 }}>
                  Final Editable Caption
                </label>
                <span
                  className="tabular"
                  style={{
                    fontSize: 11,
                    color: captionDraft.length > 2200 ? 'var(--status-danger-fg)' : 'var(--text-muted)',
                  }}
                >
                  {captionDraft.length} / 2,200 chars
                </span>
              </div>
              <textarea
                id="studio-caption-editor"
                className="textarea"
                rows={6}
                disabled={!eligibility?.edit.enabled}
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                placeholder="Write or refine your Instagram caption before publishing or scheduling..."
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={allowEmptyCaption}
                    onChange={(e) => setAllowEmptyCaption(e.target.checked)}
                    disabled={!eligibility?.edit.enabled}
                  />
                  <span>Allow intentionally empty caption</span>
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button type="button" className="btn btn-sm" onClick={() => void copyText(captionDraft, 'Caption')}>
                    Copy Caption
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!eligibility?.edit.enabled || busyAction !== null}
                    onClick={() => void handleSaveChanges()}
                  >
                    {busyAction === 'save' ? 'Saving...' : 'Save Review Draft'}
                  </button>
                </div>
              </div>
              {(parsedTags.hashtags.length > 0 || parsedTags.mentions.length > 0) && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                  {parsedTags.hashtags.map((h) => (
                    <span key={h} className="badge badge-info">
                      {h}
                    </span>
                  ))}
                  {parsedTags.mentions.map((m) => (
                    <span key={m} className="badge badge-neutral">
                      {m}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Source Post Metadata vs Published Status */}
            <div style={{ padding: 12, borderRadius: 6, border: '1px solid var(--border-default)', fontSize: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                Source Post Metrics (Captured From Source — NOT Published Analytics)
              </div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', color: 'var(--text-secondary)' }}>
                <span>Creator: {currentPost.source_username || '—'}</span>
                <span className="tabular">Source Likes: {currentPost.source_like_count || '—'}</span>
                <span className="tabular">Source Comments: {currentPost.source_comment_count || '—'}</span>
                <span className="tabular">Source Plays: {currentPost.source_play_count || '—'}</span>
              </div>
            </div>

            {/* Click 2: Publish or Schedule Controls */}
            <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Click 2: Publish / Schedule Approval</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Requires explicit confirmation modal bound to revision {currentPost.revision}.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!eligibility?.publish.enabled || busyAction !== null}
                  title={eligibility?.publish.reason || 'Publish reviewed content to Instagram'}
                  onClick={() => setModalMode('publish')}
                >
                  Publish Now
                </button>
              </div>
              {!eligibility?.publish.enabled && eligibility?.publish.reason && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Publish blocked: {eligibility.publish.reason}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <label htmlFor="studio-schedule-dt" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                    Schedule Time ({timezone})
                  </label>
                  <input
                    id="studio-schedule-dt"
                    type="datetime-local"
                    className="input"
                    value={scheduleInput}
                    onChange={(e) => setScheduleInput(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn"
                  disabled={!eligibility?.schedule.enabled || !scheduleInput || busyAction !== null}
                  title={eligibility?.schedule.reason || 'Schedule future publication'}
                  onClick={() => setModalMode('schedule')}
                >
                  Schedule Later
                </button>
              </div>
              {!eligibility?.schedule.enabled && eligibility?.schedule.reason && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Schedule blocked: {eligibility.schedule.reason}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={!eligibility?.deleteMedia.enabled || busyAction !== null}
                    title={eligibility?.deleteMedia.reason}
                    onClick={() => setModalMode('deleteMedia')}
                  >
                    Delete Media Only
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={!eligibility?.deletePost.enabled || busyAction !== null}
                    title={eligibility?.deletePost.reason}
                    onClick={() => setModalMode('deletePost')}
                  >
                    Delete Post &amp; Media
                  </button>
                </div>
                {currentPost.published_url && (
                  <a href={currentPost.published_url} target="_blank" rel="noreferrer" className="btn btn-sm">
                    View Live IG Post ({currentPost.published_id})
                  </a>
                )}
              </div>

              {currentPost.published_at && (
                <div style={{ fontSize: 12, color: 'var(--status-success-fg)' }}>
                  Published at {formatTimestampInTimezone(currentPost.published_at, timezone)} · ID{' '}
                  <span className="mono">{currentPost.published_id}</span>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <ConfirmModal
        open={modalMode !== null && currentPost !== null}
        title={
          modalMode === 'publish'
            ? `Publish ${currentPost?.post_id ?? ''} to Instagram?`
            : modalMode === 'schedule'
              ? `Schedule ${currentPost?.post_id ?? ''}?`
              : modalMode === 'deleteMedia'
                ? `Delete Cloudinary media for ${currentPost?.post_id ?? ''}?`
                : `Delete post record & stored media for ${currentPost?.post_id ?? ''}?`
        }
        description={
          modalMode === 'publish'
            ? 'This triggers Meta Graph API container creation and publication on your configured Instagram Business account.'
            : modalMode === 'schedule'
              ? `This post will remain locked in SCHEDULED state until ${scheduleInput} (${timezone}).`
              : modalMode === 'deleteMedia'
                ? 'This destroys owned Cloudinary assets via Admin/Upload API and marks the post MEDIA_DELETED while keeping the row.'
                : 'This deletes owned Cloudinary media and marks the queue record DELETED. Published posts should be archived instead.'
        }
        confirmLabel={
          modalMode === 'publish'
            ? 'Confirm Publish Now'
            : modalMode === 'schedule'
              ? 'Confirm Schedule'
              : modalMode === 'deleteMedia'
                ? 'Confirm Delete Media'
                : 'Confirm Delete Post & Media'
        }
        danger={modalMode === 'deleteMedia' || modalMode === 'deletePost'}
        requireReason={modalMode === 'deleteMedia' || modalMode === 'deletePost'}
        busy={busyAction !== null}
        details={
          currentPost
            ? [
                { label: 'Post ID', value: currentPost.post_id },
                { label: 'Media Type', value: currentPost.media_type },
                { label: 'Revision', value: currentPost.revision },
                { label: 'Account', value: overview?.accountLabel ?? '@vikas.sphere' },
                { label: 'Stored Assets', value: String(currentAssets.length) },
                { label: 'Caption Preview', value: captionDraft.slice(0, 90) || '(empty)' },
              ]
            : undefined
        }
        onCancel={() => setModalMode(null)}
        onConfirm={handleModalConfirm}
      />
    </div>
  );
}
