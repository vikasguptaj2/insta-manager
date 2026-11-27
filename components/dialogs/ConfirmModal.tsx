'use client';

import React, { useEffect, useState } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  requireReason?: boolean;
  busy?: boolean;
  details?: Array<{ label: string; value: string }>;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void> | void;
}

export function ConfirmModal(props: ConfirmModalProps) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !props.busy) props.onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  if (!props.open) return null;
  return <ConfirmModalContent key={props.title} {...props} />;
}

function ConfirmModalContent({
  title,
  description,
  confirmLabel,
  danger = false,
  requireReason = false,
  busy = false,
  details,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  const [reason, setReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const canProceed = acknowledged && (!requireReason || reason.trim().length > 0) && !busy;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
      <div className="modal-card">
        <div className="panel-header" style={{ marginBottom: 8 }}>
          <h2 id="confirm-modal-title" style={{ margin: 0, fontSize: 16 }}>
            {title}
          </h2>
          <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
            Close
          </button>
        </div>

        <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', fontSize: 13 }}>{description}</p>

        {details && details.length > 0 && (
          <div
            style={{
              background: 'var(--bg-subtle)',
              border: '1px solid var(--border-default)',
              borderRadius: 6,
              padding: 12,
              marginBottom: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {details.map((d) => (
              <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>{d.label}</span>
                <span className="mono" style={{ textAlign: 'right', wordBreak: 'break-word' }}>
                  {d.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {requireReason && (
          <div style={{ marginBottom: 14 }}>
            <label htmlFor="confirm-reason-input" style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              Audit Reason (required)
            </label>
            <input
              id="confirm-reason-input"
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Duplicate upload, expired draft, user request"
            />
          </div>
        )}

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            fontSize: 12,
            marginBottom: 16,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>I have verified the target IDs and confirm this explicit action.</span>
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!canProceed}
            onClick={() => void onConfirm(reason.trim())}
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
