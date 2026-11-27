'use client';

import type { CaptionStatus, ContentStatus, ServiceConnectionStatus, StorageStatus } from '../../types/instaops';

export function StatusBadge({ status }: { status: ContentStatus | string }) {
  const s = (status || 'DRAFT').toUpperCase();
  const cls =
    s === 'PUBLISHED' || s === 'COMPLETED' || s === 'SUCCESS'
      ? 'badge-success'
      : s === 'FAILED' || s === 'ERROR' || s === 'DELETED'
        ? 'badge-danger'
        : s === 'VERIFY_MANUALLY' || s === 'SCHEDULED' || s === 'MEDIA_DELETED'
          ? 'badge-warning'
          : s === 'EXTRACTING' || s === 'UPLOADING' || s === 'PUBLISHING' || s === 'READY' || s === 'DELETING'
            ? 'badge-info'
            : 'badge-neutral';

  return <span className={`badge ${cls}`}>{s.replaceAll('_', ' ')}</span>;
}

export function MediaTypeBadge({ type }: { type: string }) {
  const t = (type || 'REEL').toUpperCase();
  const cls = t === 'CAROUSEL' ? 'badge-warning' : t === 'IMAGE' ? 'badge-info' : 'badge-neutral';
  return <span className={`badge ${cls}`}>{t}</span>;
}

export function CaptionStatusBadge({ status }: { status: CaptionStatus }) {
  if (status === 'available') return <span className="badge badge-success">Caption extracted</span>;
  if (status === 'empty') return <span className="badge badge-neutral">Source had no caption</span>;
  if (status === 'unavailable') return <span className="badge badge-warning">Caption unavailable</span>;
  return <span className="badge badge-neutral">Not extracted</span>;
}

export function ConnectionBadge({ status }: { status: ServiceConnectionStatus['status'] }) {
  const cls =
    status === 'connected'
      ? 'badge-success'
      : status === 'degraded'
        ? 'badge-warning'
        : status === 'offline'
          ? 'badge-danger'
          : 'badge-neutral';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function StorageStatusBadge({ status }: { status: StorageStatus | string }) {
  const cls =
    status === 'ACTIVE'
      ? 'badge-success'
      : status === 'DELETED'
        ? 'badge-neutral'
        : status === 'UNMANAGED' || status === 'PARTIAL_DELETE'
          ? 'badge-warning'
          : 'badge-danger';
  return <span className={`badge ${cls}`}>{status}</span>;
}

export function formatBytes(bytes: number | string | null | undefined): string {
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let idx = 0;
  let val = n;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}
