'use client';

import React, { useMemo } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { computeOperationalAnalytics } from '../../lib/analytics/metrics';
import { formatBytes } from '../ui/Badges';
import { ActivityBarChart, HorizontalBreakdown } from '../ui/Charts';

export function AnalyticsView() {
  const { overview, loading } = useInstaOps();

  const metrics = useMemo(() => {
    if (!overview) return null;
    return computeOperationalAnalytics(overview.posts, overview.assets, overview.logs, overview.timezone);
  }, [overview]);

  if (loading && !overview) {
    return <div className="panel">Computing operational analytics...</div>;
  }

  if (!metrics || !overview) {
    return <div className="empty-state">No operational records available yet.</div>;
  }

  const totalTyped = metrics.reelsCount + metrics.imagesCount + metrics.carouselsCount;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Operational Analytics</h1>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Strictly derived from real execution logs, queue states, Cloudinary assets, and extracted metadata (zero fabricated numbers).
        </div>
      </div>

      <section className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Extraction Success Rate</span>
          <span className="kpi-value">
            {metrics.extractionSuccessRate !== null ? `${metrics.extractionSuccessRate}%` : '—'}
          </span>
          <span className="kpi-sub">Computed from W01 execution logs</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Publication Success Rate</span>
          <span className="kpi-value">
            {metrics.publicationSuccessRate !== null ? `${metrics.publicationSuccessRate}%` : '—'}
          </span>
          <span className="kpi-sub">Published vs publish failures</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Avg Workflow Duration</span>
          <span className="kpi-value">
            {metrics.averageExecutionDurationMs !== null
              ? `${(metrics.averageExecutionDurationMs / 1000).toFixed(1)}s`
              : '—'}
          </span>
          <span className="kpi-sub">Measured from ExecutionLogs</span>
        </div>
        <div className="kpi-card">
          <span className="kpi-label">Active Storage Tracked</span>
          <span className="kpi-value">{formatBytes(metrics.totalTrackedStorageBytes)}</span>
          <span className="kpi-sub">{overview.storage.activeAssets} Cloudinary active assets</span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Daily Publishing vs Failure Activity ({overview.timezone})</h2>
          <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
            <span style={{ color: 'var(--accent-primary)', fontWeight: 600 }}>Published</span>
            <span style={{ color: 'var(--status-danger-fg)', fontWeight: 600 }}>Failed / Verify</span>
          </div>
        </div>
        <ActivityBarChart data={metrics.dailyActivity} />
      </section>

      <div className="split-2">
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Queue Breakdown by Media Type</h2>
            <span className="tabular" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {totalTyped} total active items
            </span>
          </div>
          {totalTyped === 0 ? (
            <div className="empty-state">No active posts categorized yet.</div>
          ) : (
            <HorizontalBreakdown
              rows={[
                { label: 'Reels (Video)', count: metrics.reelsCount, total: totalTyped, tone: 'primary' },
                { label: 'Single Images', count: metrics.imagesCount, total: totalTyped, tone: 'primary' },
                { label: 'Carousels (2–10 mixed items)', count: metrics.carouselsCount, total: totalTyped, tone: 'primary' },
              ]}
            />
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Failure Categories</h2>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>By canonical error code</span>
          </div>
          {metrics.failedCategories.length === 0 ? (
            <div className="empty-state">Zero failed or verification-blocked records.</div>
          ) : (
            <HorizontalBreakdown
              rows={metrics.failedCategories.map((c) => ({
                label: c.code,
                count: c.count,
                total: metrics.failedCategories.reduce((s, x) => s + x.count, 0),
                tone: 'danger',
              }))}
            />
          )}
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Captured Source Post Engagement (Reference Only)</h2>
          <span className="badge badge-neutral">Source Metadata — NOT Post-Publish Insights</span>
        </div>
        <div className="kpi-grid">
          <div className="kpi-card">
            <span className="kpi-label">Posts With Source Stats</span>
            <span className="kpi-value">{metrics.sourceEngagementTotals.postsWithMetrics}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Captured Source Likes</span>
            <span className="kpi-value">{metrics.sourceEngagementTotals.totalSourceLikes.toLocaleString()}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Captured Source Comments</span>
            <span className="kpi-value">{metrics.sourceEngagementTotals.totalSourceComments.toLocaleString()}</span>
          </div>
          <div className="kpi-card">
            <span className="kpi-label">Captured Source Plays</span>
            <span className="kpi-value">{metrics.sourceEngagementTotals.totalSourcePlays.toLocaleString()}</span>
          </div>
        </div>
      </section>
    </div>
  );
}
