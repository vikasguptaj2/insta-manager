'use client';

import React, { useState } from 'react';
import { useInstaOps } from '../../hooks/use-instaops';
import { formatTimestampInTimezone } from '../../lib/scheduling/calendar';
import type { N8nExecutionDetail } from '../../types/instaops';
import { StatusBadge } from '../ui/Badges';

export function ExecutionMonitorView() {
  const { overview, fetchExecutionDetail, pushToast } = useInstaOps();
  const [selectedDetail, setSelectedDetail] = useState<N8nExecutionDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);

  const timezone = overview?.timezone ?? 'Asia/Kolkata';

  const handleInspect = async (execId: string) => {
    setLoadingDetail(execId);
    try {
      const detail = await fetchExecutionDetail(execId);
      setSelectedDetail(detail);
    } catch (e) {
      pushToast({
        kind: 'error',
        title: 'Unable to load execution trace',
        detail: e instanceof Error ? e.message : 'Check n8n API connectivity.',
      });
    } finally {
      setLoadingDetail(null);
    }
  };

  if (!overview) {
    return <div className="panel">Loading workflow monitor...</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20, letterSpacing: '-0.02em' }}>Execution Monitor</h1>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Real-time durable jobs, distributed locks, n8n workflow execution traces, and persisted `ExecutionLogs`.
        </div>
      </div>

      {/* Durable Jobs & Active Locks */}
      <div className="split-2">
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Durable Background Jobs ({overview.jobs.length})</h2>
          </div>
          {overview.jobs.length === 0 ? (
            <div className="empty-state">No recent durable jobs recorded in lock store.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Post</th>
                    <th>Operation</th>
                    <th>Stage</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.jobs.slice(0, 10).map((j) => (
                    <tr key={j.job_id}>
                      <td className="mono">{j.job_id}</td>
                      <td className="mono">{j.post_id}</td>
                      <td>{j.operation}</td>
                      <td style={{ fontSize: 12 }}>{j.stage}</td>
                      <td>
                        <StatusBadge status={j.status} />
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
            <h2 className="panel-title">Active Mutation Locks ({overview.locks.length})</h2>
          </div>
          {overview.locks.length === 0 ? (
            <div className="empty-state">Zero active mutation locks.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Lock Key</th>
                    <th>Operation</th>
                    <th>Owner</th>
                    <th>Expires ({timezone})</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.locks.map((l) => (
                    <tr key={l.lock_key}>
                      <td className="mono">{l.lock_key}</td>
                      <td>{l.operation}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{l.owner_id}</td>
                      <td className="tabular" style={{ fontSize: 12 }}>
                        {formatTimestampInTimezone(l.expires_at, timezone)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* Online n8n Executions */}
      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">n8n Workflow Executions ({overview.executions.length})</h2>
        </div>
        {overview.executions.length === 0 ? (
          <div className="empty-state">No executions returned from configured W01–W05 workflows.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Execution ID</th>
                  <th>Workflow</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th className="num-col">Duration</th>
                  <th>Started ({timezone})</th>
                  <th>Inspect</th>
                </tr>
              </thead>
              <tbody>
                {overview.executions.map((ex) => (
                  <tr key={ex.id}>
                    <td className="mono">{ex.id}</td>
                    <td>{ex.workflowName || ex.workflowId}</td>
                    <td>{ex.mode}</td>
                    <td>
                      <StatusBadge status={ex.status} />
                    </td>
                    <td className="num-col">
                      {ex.durationMs !== null && ex.durationMs !== undefined ? `${(ex.durationMs / 1000).toFixed(1)}s` : '—'}
                    </td>
                    <td className="tabular" style={{ fontSize: 12 }}>
                      {formatTimestampInTimezone(ex.startedAt, timezone)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={loadingDetail === ex.id}
                        onClick={() => void handleInspect(ex.id)}
                      >
                        {loadingDetail === ex.id ? 'Loading...' : 'Node Trace'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ExecutionLogs Tab Records */}
      <section className="panel">
        <div className="panel-header">
          <h2 className="panel-title">Persisted Execution Audit Logs ({overview.logs.length})</h2>
        </div>
        {overview.logs.length === 0 ? (
          <div className="empty-state">No persistent execution log rows recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Log ID</th>
                  <th>Post</th>
                  <th>Operation</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Error</th>
                  <th>Time ({timezone})</th>
                </tr>
              </thead>
              <tbody>
                {overview.logs.slice(0, 25).map((log) => (
                  <tr key={log.log_id}>
                    <td className="mono" style={{ fontSize: 11 }}>{log.log_id}</td>
                    <td className="mono">{log.post_id}</td>
                    <td>{log.operation}</td>
                    <td style={{ fontSize: 12 }}>{log.stage}</td>
                    <td>
                      <StatusBadge status={log.status} />
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--status-danger-fg)', maxWidth: 260 }}>
                      {log.error_code ? `${log.error_code}: ` : ''}
                      {log.error_message || '—'}
                    </td>
                    <td className="tabular" style={{ fontSize: 12 }}>
                      {formatTimestampInTimezone(log.created_at || log.started_at, timezone)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Execution Detail Modal */}
      {selectedDetail && (
        <div className="modal-backdrop" onClick={() => setSelectedDetail(null)}>
          <div className="drawer-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h2 style={{ margin: 0, fontSize: 16 }}>Execution Trace #{selectedDetail.id}</h2>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {selectedDetail.workflowName} · Last Node: {selectedDetail.lastNode || '—'}
                </div>
              </div>
              <button type="button" className="btn btn-sm" onClick={() => setSelectedDetail(null)}>
                Close
              </button>
            </div>

            {selectedDetail.errorMessage && (
              <div className="banner banner-danger" style={{ marginBottom: 12 }}>
                <span>{selectedDetail.errorMessage}</span>
              </div>
            )}

            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Node</th>
                    <th>Attempt</th>
                    <th className="num-col">ms</th>
                    <th>Status</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedDetail.nodes.map((n, i) => (
                    <tr key={`${n.name}-${i}`}>
                      <td style={{ fontWeight: 600 }}>{n.name}</td>
                      <td className="num-col">{n.attempt}</td>
                      <td className="num-col">{n.durationMs ?? '—'}</td>
                      <td>
                        <StatusBadge status={n.status} />
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--status-danger-fg)' }}>{n.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
