'use client';

import React, { useEffect, useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { ConnectionBadge } from '../ui/Badges';

import type { ReadinessMatrix } from '../../types/instaops';

interface SettingsApiResponse {
  ok: true;
  settings: {
    appName: string;
    timezone: string;
    demoMode: boolean;
    supabaseUrl?: string;
    n8nBaseUrl: string;
    downloaderBaseUrl: string;
    accountLabel: string;
    igUserId: string;
    cloudName: string;
    sheetsSyncEnabled?: boolean;
    sheetId: string;
    sheetGid: string;
    atomicLockProvider: string;
    flags: {
      schedulingEnabled: boolean;
      bulkPublishEnabled: boolean;
      aiCaptionEnabled: boolean;
      livePublishEnabled: boolean;
      liveDeleteEnabled: boolean;
    };
  };
  readiness?: ReadinessMatrix;
  validation: {
    valid: boolean;
    errors: string[];
    warnings: string[];
  };
}

export function SettingsView() {
  const {
    overview,
    theme,
    toggleTheme,
    autoRefresh,
    setAutoRefresh,
    testConnections,
    updateSettings,
    pushToast,
  } = useInstaOps();

  const [details, setDetails] = useState<SettingsApiResponse | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok) setDetails(d as SettingsApiResponse);
      })
      .catch(() => undefined);
  }, [overview?.now]);

  const handleRunHealth = async () => {
    setTesting(true);
    try {
      await testConnections(true);
    } finally {
      setTesting(false);
    }
  };

  const toggleDemoScheduling = async () => {
    if (!overview) return;
    try {
      await updateSettings({ schedulingEnabled: !overview.flags.schedulingEnabled });
    } catch (e) {
      pushToast({
        kind: 'warning',
        title: 'Flag locked',
        detail: e instanceof Error ? e.message : 'Configured via server .env.local',
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Settings &amp; System Diagnostics</h1>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Server configuration validation, feature flags, UI preferences, and live service health checks (zero exposed secrets).
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={testing} onClick={() => void handleRunHealth()}>
          {testing ? 'Refreshing...' : 'Refresh Diagnostics (?refresh=1)'}
        </button>
      </div>

      {details && (!details.validation.valid || details.validation.warnings.length > 0) && (
        <section className="panel" style={{ borderColor: 'var(--status-warning-fg)' }}>
          <h2 className="panel-title" style={{ marginBottom: 8 }}>Configuration Readiness Report</h2>
          {details.validation.errors.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--status-danger-fg)', marginBottom: 8 }}>
              <strong>Configuration errors:</strong> {details.validation.errors.join(' · ')}
            </div>
          )}
          {details.validation.warnings.map((w) => (
            <div key={w} style={{ fontSize: 12, color: 'var(--status-warning-fg)', marginBottom: 4 }}>
              Warning: {w}
            </div>
          ))}
        </section>
      )}

      {overview?.readiness && (
        <section className="panel" aria-label="Production readiness matrix">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <div>
              <h2 className="panel-title" style={{ margin: 0 }}>Production Readiness Matrix</h2>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                n8n probe: <span className="mono">{overview.readiness.n8nDiagnosticStatus ?? 'not_tested'}</span>
                {overview.diagnosticsRequestId ? ` · req ${overview.diagnosticsRequestId.slice(0, 8)}` : ''}
                {overview.diagnosticsFromCache ? ' · served from cache' : ''}
                {overview.readiness.lastSuccessfulCheckAt
                  ? ` · last OK ${new Date(overview.readiness.lastSuccessfulCheckAt).toLocaleString()}`
                  : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className={`badge ${overview.readiness.readyForExtraction ? 'badge-success' : 'badge-warning'}`}>
                Extraction: {overview.readiness.readyForExtraction ? 'READY' : 'GATED'}
              </span>
              <span className={`badge ${overview.readiness.readyForPublishing ? 'badge-success' : 'badge-warning'}`}>
                Publishing: {overview.readiness.readyForPublishing ? 'READY' : 'GATED'}
              </span>
              <span className={`badge ${overview.readiness.readyForDeletion ? 'badge-success' : 'badge-warning'}`}>
                Deletion: {overview.readiness.readyForDeletion ? 'READY' : 'GATED'}
              </span>
              <span className={`badge ${overview.readiness.readyForScheduling ? 'badge-success' : 'badge-neutral'}`}>
                Scheduling: {overview.readiness.readyForScheduling ? 'READY' : 'PAUSED'}
              </span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {[
              ['Config Valid', overview.readiness.configurationValid],
              ['Supabase Reachable', overview.readiness.supabaseReachable],
              ['Schema Verified', overview.readiness.databaseSchemaVerified],
              ['Atomic RPC Self-Test', overview.readiness.atomicRpcTested],
              ['RLS Verified', overview.readiness.rlsVerified],
              ['Runtime Settings RPC', Boolean(overview.readiness.runtimeSettingsAvailable)],
              ['n8n Authenticated', overview.readiness.n8nAuthenticated],
              ['n8n Mgmt API Auth', Boolean(overview.readiness.n8nManagementAuthenticated)],
              ['W01-W05 Configured', overview.readiness.requiredWorkflowsConfigured],
              ['Workflow Integrity', Boolean(overview.readiness.workflowIntegrityVerified)],
              ['Required WFs Active', Boolean(overview.readiness.requiredWorkflowsActive)],
              ['Webhook Auth Verified', Boolean(overview.readiness.webhookAuthVerified)],
              ['Downloader Auth', overview.readiness.downloaderAuthVerified],
              ['Cloudinary Auth', overview.readiness.cloudinaryAuthenticated],
              ['Instagram Auth', overview.readiness.instagramAuthenticated],
              ['Google Sheets Sync', Boolean(overview.readiness.sheetsReachable)],
              ['Live Publish Gate', Boolean(overview.readiness.livePublishGateEnabled)],
              ['Live Delete Gate', Boolean(overview.readiness.liveDeleteGateEnabled)],
            ].map(([label, ok]) => (
              <div
                key={String(label)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-default)',
                  fontSize: 12,
                }}
              >
                <span>{String(label)}</span>
                <span className={`badge ${ok ? 'badge-success' : 'badge-danger'}`}>{ok ? 'PASS' : 'NO'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {overview?.readiness?.workflowReports && overview.readiness.workflowReports.length > 0 && (
        <section className="panel" aria-label="Remote n8n workflow integrity">
          <div className="panel-header">
            <h2 className="panel-title">Remote n8n Workflow Integrity (W01–W05)</h2>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Workflow ID</th>
                  <th>State</th>
                  <th className="num-col">Nodes</th>
                  <th>Webhook Paths</th>
                  <th>Integrity Flags &amp; Diagnostics</th>
                </tr>
              </thead>
              <tbody>
                {overview.readiness.workflowReports.map((wf) => (
                  <tr key={wf.role}>
                    <td className="mono" style={{ fontWeight: 700 }}>{wf.role}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{wf.workflowId || '—'}</td>
                    <td>
                      {wf.active ? (
                        <span className="badge badge-success">Active</span>
                      ) : wf.required ? (
                        <span className="badge badge-danger">Inactive</span>
                      ) : (
                        <span className="badge badge-neutral">Paused (W03)</span>
                      )}
                    </td>
                    <td className="num-col">
                      {wf.nodeCount}/{wf.expectedMaxNodes}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {wf.webhookPaths.length > 0 ? wf.webhookPaths.join(', ') : 'cron / none'}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <span className={`badge ${wf.integrityOk ? 'badge-success' : wf.required ? 'badge-danger' : 'badge-warning'}`}>
                          {wf.integrityOk ? 'INTEGRITY OK' : 'ATTENTION'}
                        </span>
                        {wf.hasDuplicateCanvasSuspected && <span className="badge badge-danger">Duplicate Canvas</span>}
                        {wf.conflictingActiveWorkflowIds.length > 0 && (
                          <span className="badge badge-danger">Webhook Conflict</span>
                        )}
                        {wf.hasUnboundPlaceholders && <span className="badge badge-danger">Unbound Placeholder</span>}
                        {wf.hasLegacyIfSchema && <span className="badge badge-danger">Legacy IF v1</span>}
                      </div>
                      {wf.errors.length > 0 && (
                        <div style={{ color: 'var(--status-danger-fg)', marginTop: 4 }}>{wf.errors.join(' · ')}</div>
                      )}
                      {wf.warnings.length > 0 && (
                        <div style={{ color: 'var(--status-warning-fg)', marginTop: 2 }}>{wf.warnings.join(' · ')}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Live Service Connections</h2>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Integration</th>
                <th>Status</th>
                <th>Diagnostic State</th>
                <th>Details</th>
                <th className="num-col">HTTP / Latency</th>
              </tr>
            </thead>
            <tbody>
              {(overview?.connections ?? []).map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td>
                    <ConnectionBadge status={c.status} />
                  </td>
                  <td style={{ fontSize: 11 }}>
                    <span className="mono">{c.diagnosticState ?? '—'}</span>
                    {c.fromCache ? <span style={{ color: 'var(--text-muted)' }}> (cache)</span> : null}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    <div>{c.detail}</div>
                    {(c.executionId || c.requestId || c.errorCode) && (
                      <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                        {c.errorCode ? `code=${c.errorCode} ` : ''}
                        {c.executionId ? `exec=${c.executionId} ` : ''}
                        {c.requestId ? `req=${c.requestId.slice(0, 8)}` : ''}
                      </div>
                    )}
                  </td>
                  <td className="num-col">
                    {c.httpStatus ? `HTTP ${c.httpStatus} · ` : ''}
                    {c.latencyMs !== undefined ? `${c.latencyMs} ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="split-2">
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Non-Sensitive Runtime Configuration</h2>
          </div>
          {details ? (
            <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
              <Row label="Supabase Primary DB" value={details.settings.supabaseUrl || 'Configured via server .env.local'} />
              <Row label="Instagram Account" value={`${details.settings.accountLabel} (${details.settings.igUserId})`} />
              <Row label="Online n8n Server" value={details.settings.n8nBaseUrl} />
              <Row label="Hosted Downloader" value={details.settings.downloaderBaseUrl} />
              <Row label="Cloudinary Cloud" value={details.settings.cloudName} />
              <Row
                label="Google Sheets Reporting"
                value={`${details.settings.sheetsSyncEnabled ? 'Synced' : 'Disabled'} · ${details.settings.sheetId}`}
              />
              <Row label="Atomic Lock Provider" value={details.settings.atomicLockProvider} />
              <Row label="Operational Timezone" value={details.settings.timezone} />
              <Row label="Execution Mode" value={details.settings.demoMode ? 'DEMO_MODE (Sandbox)' : 'Live Supabase + n8n Bridge'} />
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading server settings...</div>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Safety Feature Flags &amp; UI Preferences</h2>
          </div>
          <div style={{ display: 'grid', gap: 10, fontSize: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Scheduling (`SCHEDULING_ENABLED`)</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className={`badge ${overview?.flags.schedulingEnabled ? 'badge-success' : 'badge-neutral'}`}>
                  {overview?.flags.schedulingEnabled ? 'Enabled' : 'Disabled'}
                </span>
                {overview?.demo && (
                  <button type="button" className="btn btn-sm" onClick={() => void toggleDemoScheduling()}>
                    Toggle Demo Flag
                  </button>
                )}
              </div>
            </div>
            <Row
              label="Live Publish Gate (LIVE_PUBLISH_ENABLED)"
              value={overview?.flags.livePublishEnabled ? 'TRUE (Active)' : 'FALSE (Safe Dry-Gate)'}
            />
            <Row
              label="Live Delete Gate (LIVE_DELETE_ENABLED)"
              value={overview?.flags.liveDeleteEnabled ? 'TRUE (Active)' : 'FALSE (Protected)'}
            />
            <Row
              label="Bulk Publishing (BULK_PUBLISH_ENABLED)"
              value={overview?.flags.bulkPublishEnabled ? 'TRUE' : 'FALSE (Recommended)'}
            />
            <Row
              label="Optional AI Captioning (AI_CAPTION_ENABLED)"
              value={overview?.flags.aiCaptionEnabled ? 'TRUE' : 'FALSE'}
            />

            <div style={{ borderTop: '1px solid var(--border-default)', paddingTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-sm" onClick={toggleTheme}>
                Switch to {theme === 'light' ? 'Dark' : 'Light'} Mode
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setAutoRefresh(!autoRefresh)}>
                Auto-Sync Polling: {autoRefresh ? 'Enabled' : 'Paused'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        paddingBottom: 6,
        borderBottom: '1px solid var(--border-default)',
      }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="mono" style={{ textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}
