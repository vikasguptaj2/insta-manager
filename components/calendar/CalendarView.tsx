'use client';

import Link from 'next/link';
import React, { useMemo, useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import {
  formatTimestampInTimezone,
  getDefaultScheduleInput,
  getMonthGridDays,
  getScheduledAndPublishedTimeline,
  getWeekDates,
  localDateTimeInputToUtcIso,
  toTimezoneDateKey,
  utcIsoToLocalDateTimeInput,
} from '../../lib/scheduling/calendar';
import type { ContentRecord } from '../../types/instaops';
import { MediaTypeBadge, StatusBadge } from '../ui/Badges';

export function CalendarView() {
  const { overview, pushToast, schedulePost, cancelSchedule } = useInstaOps();
  const [viewMode, setViewMode] = useState<'month' | 'week' | 'list'>('month');
  const [refDate, setRefDate] = useState(() => new Date());
  const [selectedDayKey, setSelectedDayKey] = useState<string>('');
  const [rescheduleTarget, setRescheduleTarget] = useState<ContentRecord | null>(null);
  const [rescheduleInput, setRescheduleInput] = useState('');
  const [busy, setBusy] = useState(false);

  const timezone = overview?.timezone ?? 'Asia/Kolkata';

  const timeline = useMemo(
    () => getScheduledAndPublishedTimeline(overview?.posts ?? [], timezone),
    [overview?.posts, timezone],
  );

  const monthCells = useMemo(() => getMonthGridDays(refDate), [refDate]);
  const weekDays = useMemo(() => getWeekDates(refDate), [refDate]);
  const todayKey = useMemo(() => toTimezoneDateKey(new Date().toISOString(), timezone), [timezone]);

  const listItems = useMemo(() => {
    return (overview?.posts ?? [])
      .filter((p) => p.status === 'SCHEDULED' || p.status === 'PUBLISHED')
      .sort((a, b) => Date.parse(b.publish_at || b.published_at || '0') - Date.parse(a.publish_at || a.published_at || '0'));
  }, [overview?.posts]);

  const stepMonth = (delta: number) => {
    setRefDate((d) => new Date(d.getFullYear(), d.getMonth() + delta, 1));
  };

  const openReschedule = (post: ContentRecord) => {
    setRescheduleTarget(post);
    setRescheduleInput(
      post.publish_at ? utcIsoToLocalDateTimeInput(post.publish_at, timezone) : getDefaultScheduleInput(timezone),
    );
  };

  const handleConfirmReschedule = async () => {
    if (!rescheduleTarget) return;
    setBusy(true);
    try {
      const utcIso = localDateTimeInputToUtcIso(rescheduleInput, timezone);
      await schedulePost(rescheduleTarget.post_id, {
        confirm: true,
        reviewedRevision: rescheduleTarget.revision,
        publish_at: utcIso,
      });
      setRescheduleTarget(null);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Reschedule rejected',
        detail: e instanceof Error ? e.message : 'Check date/time constraints.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCancelSchedule = async (postId: string) => {
    setBusy(true);
    try {
      await cancelSchedule(postId);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Cancel rejected',
        detail: e instanceof Error ? e.message : 'Unable to unschedule.',
      });
    } finally {
      setBusy(false);
    }
  };

  const selectedDayItems = selectedDayKey ? timeline.get(selectedDayKey) ?? [] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Publishing Calendar</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Displayed in {timezone} · Stored as UTC ISO timestamps · Scheduling flag:{' '}
            {overview?.flags.schedulingEnabled ? 'Enabled' : 'Disabled'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={() => stepMonth(-1)}>
            Prev Month
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setRefDate(new Date())}>
            Today
          </button>
          <button type="button" className="btn btn-sm" onClick={() => stepMonth(1)}>
            Next Month
          </button>
          <button
            type="button"
            className={`btn btn-sm ${viewMode === 'month' ? 'btn-primary' : ''}`}
            onClick={() => setViewMode('month')}
          >
            Month
          </button>
          <button
            type="button"
            className={`btn btn-sm ${viewMode === 'week' ? 'btn-primary' : ''}`}
            onClick={() => setViewMode('week')}
          >
            Week
          </button>
          <button
            type="button"
            className={`btn btn-sm ${viewMode === 'list' ? 'btn-primary' : ''}`}
            onClick={() => setViewMode('list')}
          >
            Agenda List
          </button>
        </div>
      </div>

      <div style={{ fontWeight: 600, fontSize: 15 }}>
        {refDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
      </div>

      {viewMode === 'month' && (
        <section className="panel" style={{ padding: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6, marginBottom: 6 }}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d} style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', padding: '2px 6px' }}>
                {d}
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 6 }}>
            {monthCells.map((cell) => {
              const items = cell.day ? timeline.get(cell.key) ?? [] : [];
              const isToday = cell.key === todayKey;
              return (
                <button
                  key={cell.key}
                  type="button"
                  disabled={!cell.day}
                  onClick={() => cell.day && setSelectedDayKey(cell.key)}
                  style={{
                    minHeight: 88,
                    padding: 6,
                    textAlign: 'left',
                    borderRadius: 6,
                    border: isToday ? '2px solid var(--accent-primary)' : '1px solid var(--border-default)',
                    background: cell.day ? 'var(--bg-surface)' : 'var(--bg-subtle)',
                    cursor: cell.day ? 'pointer' : 'default',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  {cell.day && (
                    <span className="tabular" style={{ fontSize: 12, fontWeight: 700 }}>
                      {cell.day}
                    </span>
                  )}
                  {items.slice(0, 2).map((item) => (
                    <span
                      key={item.post_id}
                      className={`badge ${item.status === 'PUBLISHED' ? 'badge-success' : 'badge-warning'}`}
                      style={{ fontSize: 10, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                      {item.post_id}
                    </span>
                  ))}
                  {items.length > 2 && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>+{items.length - 2} more</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {viewMode === 'week' && (
        <section className="panel">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            {weekDays.map((w) => {
              const items = timeline.get(w.key) ?? [];
              return (
                <div
                  key={w.key}
                  style={{
                    border: '1px solid var(--border-default)',
                    borderRadius: 6,
                    padding: 10,
                    minHeight: 160,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 8 }}>{w.key}</div>
                  {items.length === 0 ? (
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Empty slot</div>
                  ) : (
                    items.map((p) => (
                      <div
                        key={p.post_id}
                        style={{
                          padding: 6,
                          borderRadius: 4,
                          background: 'var(--bg-subtle)',
                          marginBottom: 6,
                          fontSize: 11,
                        }}
                      >
                        <div className="mono" style={{ fontWeight: 700 }}>{p.post_id}</div>
                        <StatusBadge status={p.status} />
                      </div>
                    ))
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {(viewMode === 'list' || selectedDayKey) && (
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              {selectedDayKey && viewMode !== 'list' ? `Day Details: ${selectedDayKey}` : 'Scheduled & Published Agenda'}
            </h2>
            {selectedDayKey && viewMode !== 'list' && (
              <button type="button" className="btn btn-sm" onClick={() => setSelectedDayKey('')}>
                Clear Day
              </button>
            )}
          </div>
          {(selectedDayKey && viewMode !== 'list' ? selectedDayItems : listItems).length === 0 ? (
            <div className="empty-state">No scheduled or published entries for this view.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Post</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Timestamp ({timezone})</th>
                    <th>Caption</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedDayKey && viewMode !== 'list' ? selectedDayItems : listItems).map((p) => (
                    <tr key={p.post_id}>
                      <td className="mono">{p.post_id}</td>
                      <td>
                        <MediaTypeBadge type={p.media_type} />
                      </td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="tabular" style={{ fontSize: 12 }}>
                        {formatTimestampInTimezone(p.publish_at || p.published_at, timezone)}
                      </td>
                      <td style={{ maxWidth: 260 }}>
                        {(p.caption || p.original_caption || '(empty)').slice(0, 80)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <Link href={`/create?postId=${encodeURIComponent(p.post_id)}`} className="btn btn-sm">
                            Studio
                          </Link>
                          {p.status === 'SCHEDULED' && (
                            <>
                              <button type="button" className="btn btn-sm" onClick={() => openReschedule(p)}>
                                Reschedule
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                disabled={busy}
                                onClick={() => void handleCancelSchedule(p.post_id)}
                              >
                                Cancel
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {rescheduleTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reschedule-modal-title">
          <div className="modal-card">
            <div className="panel-header">
              <h2 id="reschedule-modal-title" style={{ margin: 0, fontSize: 16 }}>
                Reschedule {rescheduleTarget.post_id}
              </h2>
              <button type="button" className="btn btn-sm" onClick={() => setRescheduleTarget(null)} disabled={busy}>
                Close
              </button>
            </div>
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 0 }}>
              Choose a new publication time in <strong>{timezone}</strong>. It is stored cleanly as UTC ISO.
            </p>
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="reschedule-dt-input" style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
                New Schedule Time ({timezone})
              </label>
              <input
                id="reschedule-dt-input"
                type="datetime-local"
                className="input"
                value={rescheduleInput}
                onChange={(e) => setRescheduleInput(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setRescheduleTarget(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !rescheduleInput}
                onClick={() => void handleConfirmReschedule()}
              >
                {busy ? 'Saving...' : 'Save New Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
