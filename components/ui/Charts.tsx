'use client';

interface DailyActivityPoint {
  label: string;
  published: number;
  failed: number;
}

export function ActivityBarChart({ data }: { data: DailyActivityPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="empty-state">
        No extracted or published activity recorded yet. Real operational counts appear automatically once posts run.
      </div>
    );
  }

  const maxVal = Math.max(1, ...data.map((d) => d.published + d.failed));
  const width = 620;
  const height = 180;
  const padBottom = 26;
  const chartH = height - padBottom - 16;
  const colW = width / Math.max(1, data.length);
  const barW = Math.min(34, Math.max(12, colW * 0.52));

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', minWidth: 360, height: 185 }} role="img" aria-label="Daily publication activity chart">
        {[0, 0.5, 1].map((step) => {
          const y = 16 + chartH * (1 - step);
          return (
            <line
              key={step}
              x1={0}
              x2={width}
              y1={y}
              y2={y}
              stroke="var(--border-default)"
              strokeDasharray="3 3"
              strokeWidth={1}
            />
          );
        })}
        {data.map((d, i) => {
          const x = i * colW + (colW - barW) / 2;
          const pubH = (d.published / maxVal) * chartH;
          const failH = (d.failed / maxVal) * chartH;
          const pubY = 16 + (chartH - pubH);
          const failY = pubY - failH;
          return (
            <g key={d.label}>
              {d.published > 0 && (
                <rect x={x} y={pubY} width={barW} height={pubH} rx={3} fill="var(--accent-primary)" />
              )}
              {d.failed > 0 && (
                <rect x={x} y={failY} width={barW} height={failH} rx={3} fill="var(--status-danger-fg)" />
              )}
              <text
                x={x + barW / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize={10}
                fill="var(--text-muted)"
              >
                {d.label.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function HorizontalBreakdown({
  rows,
}: {
  rows: Array<{ label: string; count: number; total: number; tone?: 'primary' | 'danger' | 'warning' }>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => {
        const pct = r.total > 0 ? Math.round((r.count / r.total) * 100) : 0;
        const fill =
          r.tone === 'danger'
            ? 'var(--status-danger-fg)'
            : r.tone === 'warning'
              ? 'var(--status-warning-fg)'
              : 'var(--accent-primary)';
        return (
          <div key={r.label}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
              <span>{r.label}</span>
              <span className="tabular" style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
                {r.count} ({pct}%)
              </span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%`, background: fill }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
