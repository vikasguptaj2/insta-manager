'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { ConnectionBadge, formatBytes, MediaTypeBadge, StatusBadge } from '../ui/Badges';
import { formatTimestampInTimezone } from '../../lib/scheduling/calendar';

export function OverviewView() {
  const { overview, loading, testConnections } = useInstaOps();
  const [testing, setTesting] = useState(false);

  if (loading && !overview) {
    return <div className="panel">Loading operational overview...</div>;
  }

  if (!overview) {
    return (
      <div className="panel">
        <h1 style={{ marginTop: 0 }}>Operational Overview</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          Dashboard state is not available yet. Verify configuration in <Link href="/settings" style={{ textDecoration: 'underline' }}>Settings</Link>.
        </p>
      </div>
    );
  }

  const recentPosts = [...overview.posts]
    .filter((p) => p.status !== 'DELETED')
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || '0') - Date.parse(a.updated_at || a.created_at || '0'))
    .slice(0, 8);

  const handleTest = async () => {
    setTesting(true);
    try {
      await testConnections();
    } finally {
      setTesting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Operational Overview</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Account {overview.accountLabel} · Cloud `{overview.cloudName}` · Graph API v22.0
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/create" className="btn btn-primary">
            + Open Post Studio
          </Link>
          <Link href="/recovery" className="btn">
            Recovery ({overview.stats.failed + overview.stats.verifyManually})
          </Link>
          <button type="button" className="btn" onClick={() => void handleTest()} disabled={testing}>
            {testing ? 'Checking...' : 'Test Connections'}
          </button>
        </div>
      </div>

      <section className="kpi-grid" aria-label="Operational KPI summary">
        <div className="kpi-card">
          <span className="kpi-label">Total Active Queue</span>
          <span className="kpi-value">{overview.stats.totalPosts}</span>
          <span className="kpi-sub">
            {overview.stats.drafts} Draft · {overview.stats.ready} Ready
          </span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Scheduled</span>
          <span className="kpi-value">{overview.stats.scheduled}</span>
          <span className="kpi-sub">
            {overview.flags.schedulingEnabled ? 'Runner flag enabled' : 'Scheduling paused'}
          </span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Published</span>
          <span className="kpi-value">{overview.stats.published}</span>
          <span className="kpi-sub">
            Rate:{' '}
            {overview.stats.publishSuccessRate !== null ? `${overview.stats.publishSuccessRate}%` : 'No attempts yet'}
          </span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Failed / Needs Verify</span>
          <span
            className="kpi-value"
            style={{
              color:
                overview.stats.failed + overview.stats.verifyManually > 0
                  ? 'var(--status-danger-fg)'
                  : 'var(--text-primary)',
            }}
          >
            {overview.stats.failed + overview.stats.verifyManually}
          </span>
          <span className="kpi-sub">
            {overview.stats.failed} Failed · {overview.stats.verifyManually} Verify
          </span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Cloudinary Assets</span>
          <span className="kpi-value">{overview.storage.activeAssets}</span>
          <span className="kpi-sub">Tracked {formatBytes(overview.storage.totalTrackedBytes)}</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Active Jobs</span>
          <span className="kpi-value">{overview.stats.activeJobs}</span>
          <span className="kpi-sub">
            Extraction rate:{' '}
            {overview.stats.extractSuccessRate !== null ? `${overview.stats.extractSuccessRate}%` : 'N/A'}
          </span>
        </div>
      </section>

      <div className="split-2">
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Next Scheduled Post & Recent Runs</h2>
            <Link href="/calendar" className="btn btn-sm">
              Open Calendar
            </Link>
          </div>
          {overview.nextScheduledPost ? (
            <div
              style={{
                padding: 12,
                borderRadius: 6,
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-default)',
                marginBottom: 14,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span className="mono" style={{ fontWeight: 700 }}>
                  {overview.nextScheduledPost.post_id}
                </span>
                <StatusBadge status={overview.nextScheduledPost.status} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                Due:{' '}
                <strong>
                  {formatTimestampInTimezone(overview.nextScheduledPost.publish_at, overview.timezone)}
                </strong>{' '}
                ({overview.timezone})
              </div>
              <div style={{ fontSize: 12, marginTop: 6 }}>
                {overview.nextScheduledPost.caption
                  ? overview.nextScheduledPost.caption.slice(0, 120)
                  : '(No caption set)'}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
              No future posts currently scheduled.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Last Extraction</span>
              <span className="tabular">
                {overview.lastExtractionAt
                  ? formatTimestampInTimezone(overview.lastExtractionAt, overview.timezone)
                  : 'Never'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Last Publication</span>
              <span className="tabular">
                {overview.lastPublicationAt
                  ? formatTimestampInTimezone(overview.lastPublicationAt, overview.timezone)
                  : 'Never'}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Primary Source of Truth</span>
              <span>Supabase PostgreSQL · Google Sheets Sync Layer</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>Carousel Publishing</span>
              <span>Enabled (2–10 mixed images &amp; videos)</span>
            </div>
            {(overview.stats.syncPendingCount ?? 0) > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--status-warning-fg)' }}>
                <span>Pending Google Sheets Sync</span>
                <span className="tabular">{overview.stats.syncPendingCount} queued item(s)</span>
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Service Connection Matrix</h2>
            <Link href="/settings" className="btn btn-sm">
              Diagnostics
            </Link>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {overview.connections.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                  fontSize: 12,
                  paddingBottom: 6,
                  borderBottom: '1px solid var(--border-default)',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.detail}</div>
                </div>
                <ConnectionBadge status={c.status} />
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Recent Content Activity</h2>
          <Link href="/content" className="btn btn-sm">
            View Full Queue ({overview.stats.totalPosts})
          </Link>
        </div>

        {recentPosts.length === 0 ? (
          <div className="empty-state">
            Queue is empty. <Link href="/create" style={{ textDecoration: 'underline' }}>Create a draft in Post Studio</Link> to start extracting media.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Post ID</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Caption Preview</th>
                  <th className="num-col">Size</th>
                  <th>Updated</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {recentPosts.map((p) => (
                  <tr key={p.post_id}>
                    <td className="mono">{p.post_id}</td>
                    <td>
                      <MediaTypeBadge type={p.media_type} />
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td style={{ maxWidth: 320 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.caption || p.original_caption || <span style={{ color: 'var(--text-muted)' }}>No caption</span>}
                      </div>
                    </td>
                    <td className="num-col">{formatBytes(p.file_size_bytes)}</td>
                    <td className="tabular" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {formatTimestampInTimezone(p.updated_at || p.created_at, overview.timezone)}
                    </td>
                    <td>
                      <Link href={`/create?postId=${encodeURIComponent(p.post_id)}`} className="btn btn-sm">
                        Open in Studio
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
