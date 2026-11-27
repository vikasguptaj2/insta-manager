'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React, { useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { formatTimestampInTimezone } from '../../lib/scheduling/calendar';

interface NavEntry {
  href: string;
  label: string;
  badgeKey?: 'queue' | 'media' | 'scheduled' | 'published' | 'executions' | 'recovery';
}

const NAV_ITEMS: NavEntry[] = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/create', label: 'Post Studio' },
  { href: '/content', label: 'Content Queue', badgeKey: 'queue' },
  { href: '/media', label: 'Media Library', badgeKey: 'media' },
  { href: '/calendar', label: 'Calendar', badgeKey: 'scheduled' },
  { href: '/published', label: 'Published', badgeKey: 'published' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/executions', label: 'Executions', badgeKey: 'executions' },
  { href: '/recovery', label: 'Recovery', badgeKey: 'recovery' },
  { href: '/settings', label: 'Settings' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '/dashboard';
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const {
    overview,
    refreshing,
    loadError,
    lastSyncedAt,
    autoRefresh,
    setAutoRefresh,
    theme,
    toggleTheme,
    toasts,
    dismissToast,
    activeJobs,
    refreshOverview,
  } = useInstaOps();

  const getBadgeCount = (key?: NavEntry['badgeKey']): number | null => {
    if (!key || !overview) return null;
    if (key === 'queue') return overview.stats.totalPosts;
    if (key === 'media') return overview.storage.activeAssets;
    if (key === 'scheduled') return overview.stats.scheduled;
    if (key === 'published') return overview.stats.published;
    if (key === 'executions') return overview.stats.activeJobs || overview.executions.length;
    if (key === 'recovery') return overview.stats.failed + overview.stats.verifyManually;
    return null;
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Main navigation">
        <div className="sidebar-brand">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: '-0.02em' }}>InstaOps v2.0</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Instagram Ops Console</div>
            </div>
            <button
              type="button"
              className="btn btn-sm mobile-only"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation menu"
            >
              Close
            </button>
          </div>
          <div
            style={{
              marginTop: 10,
              padding: '6px 8px',
              borderRadius: 6,
              background: 'var(--bg-subtle)',
              fontSize: 11,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span style={{ fontWeight: 600 }}>{overview?.accountLabel ?? '@vikas.sphere'}</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {(overview?.igUserId ?? '17841453414532595').slice(-6)}
            </span>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => {
            const active =
              pathname === item.href ||
              (item.href === '/dashboard' && pathname === '/') ||
              (item.href !== '/dashboard' && pathname.startsWith(item.href));
            const count = getBadgeCount(item.badgeKey);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item ${active ? 'active' : ''}`}
                onClick={() => setSidebarOpen(false)}
              >
                <span>{item.label}</span>
                {count !== null && (
                  <span
                    className="nav-count"
                    style={
                      item.badgeKey === 'recovery' && count > 0
                        ? { background: 'var(--status-danger-bg)', color: 'var(--status-danger-fg)' }
                        : undefined
                    }
                  >
                    {count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div style={{ padding: 12, borderTop: '1px solid var(--border-default)', fontSize: 11, color: 'var(--text-muted)' }}>
          <div>TZ: {overview?.timezone ?? 'Asia/Kolkata'}</div>
          <div>
            Synced: {lastSyncedAt ? formatTimestampInTimezone(lastSyncedAt, overview?.timezone ?? 'Asia/Kolkata') : 'Pending'}
          </div>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm mobile-only"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open navigation menu"
            >
              Menu
            </button>

            {overview?.demo && (
              <span className="badge badge-warning" title="Running with isolated in-memory sample records">
                DEMO SANDBOX
              </span>
            )}

            {overview && !overview.demo && !overview.flags.livePublishEnabled && (
              <span className="badge badge-neutral" title="LIVE_PUBLISH_ENABLED=false">
                Live Publish Off
              </span>
            )}

            {activeJobs.length > 0 && (
              <Link href="/executions" className="badge badge-info">
                {activeJobs.length} active job{activeJobs.length > 1 ? 's' : ''}
              </Link>
            )}

            {overview?.cooldown?.blocked && (
              <span className="badge badge-danger">
                Cooldown active{overview.cooldown.until ? ` until ${formatTimestampInTimezone(overview.cooldown.until, overview.timezone)}` : ''}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              title="Toggle periodic polling"
            >
              Auto-Sync: {autoRefresh ? 'On' : 'Paused'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void refreshOverview(false)} disabled={refreshing}>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
            <button type="button" className="btn btn-sm" onClick={toggleTheme} aria-label="Toggle color theme">
              {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
            </button>
          </div>
        </header>

        <main className="page-content">
          {loadError && (
            <div className="banner banner-danger" role="alert">
              <div>
                <strong>Connection / Sync Notice:</strong> {loadError}
              </div>
              <button type="button" className="btn btn-sm" onClick={() => void refreshOverview(false)}>
                Retry
              </button>
            </div>
          )}

          {overview?.cooldown?.blocked && (
            <div className="banner banner-warning" role="status">
              <div>
                <strong>Extraction Cooldown Active:</strong> Upstream rate-limit or unresolved extraction detected.
                Pause new extraction calls{overview.cooldown.until ? ` until ${formatTimestampInTimezone(overview.cooldown.until, overview.timezone)}` : ''} or inspect Recovery.
              </div>
              <Link href="/recovery" className="btn btn-sm">
                Open Recovery
              </Link>
            </div>
          )}

          {children}
        </main>
      </div>

      {toasts.length > 0 && (
        <div className="toast-stack" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} role="status">
              <div>
                <div style={{ fontWeight: 600 }}>{t.title}</div>
                {t.detail && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{t.detail}</div>}
              </div>
              <button type="button" className="btn btn-sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
