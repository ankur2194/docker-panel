import { useEffect, useState } from 'preact/hooks';
import { Icon } from './icons.jsx';
import { HISTORY, INTERVALS, LEVELS, fmtPct, levelOf } from './load.js';

const lvlClass = (lvl) => `lvl-${lvl?.key || 'none'}`;

/** The load level as text, so color never carries the meaning alone. */
export function LoadPill({ pct, level = levelOf(pct) }) {
  if (!level) return <span class="faint small">—</span>;
  return (
    <span class={`load-pill ${lvlClass(level)}`} title={`${level.label} load (${level.range})`}>
      <span class="dot" />{level.label}
    </span>
  );
}

/** Horizontal bar, colored by the load level of `pct`. */
export function Meter({ pct, label }) {
  const lvl = levelOf(pct);
  const w = pct == null ? 0 : Math.min(100, Math.max(pct > 0 ? 2 : 0, pct));
  return (
    <div class={`meter ${lvlClass(lvl)}`} role="meter" aria-label={label} aria-valuemin="0" aria-valuemax="100"
      aria-valuenow={pct == null ? undefined : Math.round(pct)} aria-valuetext={lvl ? `${fmtPct(pct)}, ${lvl.label.toLowerCase()} load` : 'no data'}
      title={lvl ? `${fmtPct(pct)} · ${lvl.label} load` : ''}>
      <span style={{ width: `${w}%` }} />
    </div>
  );
}

/**
 * Tiny line chart of recent samples, newest at the right edge.
 * points: [{ t, v }]. Percentages use a fixed 0–100 scale and take the color of the latest level;
 * other values (rates) scale to their own maximum and use the accent color.
 */
export function Sparkline({ points, label, pct = true, format = fmtPct, height = 36 }) {
  const [hover, setHover] = useState(null);
  const W = 240, H = height;
  const n = points.length;
  const max = pct ? 100 : Math.max(1, ...points.map((p) => p.v || 0)) * 1.15;
  // the window grows with the samples (at least 30 slots) until it holds the whole history
  const step = W / (Math.min(HISTORY, Math.max(30, n)) - 1);
  const x = (i) => W - (n - 1 - i) * step;
  const y = (v) => H - 1.5 - (Math.min(v, max) / max) * (H - 3);

  let line = '', area = '', run = [];
  const flush = () => {
    if (!run.length) return;
    const seg = run.map((i, k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(points[i].v).toFixed(1)}`).join('');
    line += seg;
    area += `${seg}L${x(run[run.length - 1]).toFixed(1)},${H}L${x(run[0]).toFixed(1)},${H}Z`;
    run = [];
  };
  points.forEach((p, i) => (p.v == null ? flush() : run.push(i)));
  flush();

  const last = [...points].reverse().find((p) => p.v != null);
  const lvl = pct ? levelOf(last?.v) : null;
  const h = hover != null ? points[hover] : null;

  const onMove = (e) => {
    if (!n) return;
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(n - 1 - (W - fx) / step))));
  };

  return (
    <div class={`spark ${pct ? lvlClass(lvl) : 'lvl-rate'}`} style={{ height: `${H}px` }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`${label}: ${n} samples${last ? `, latest ${format(last.v)}` : ''}`}>
        <line class="spark-base" x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} />
        <path class="spark-area" d={area} />
        <path class="spark-line" d={line} vector-effect="non-scaling-stroke" />
      </svg>
      {h && h.v != null && (
        <>
          <span class="spark-cursor" style={{ left: `${(x(hover) / W) * 100}%` }} />
          <span class="spark-dot" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(h.v) / H) * 100}%` }} />
          <span class={`spark-tip ${x(hover) > W / 2 ? 'left' : ''}`} style={{ left: `${(x(hover) / W) * 100}%` }}>
            <strong>{format(h.v)}</strong> <span class="faint">{new Date(h.t).toLocaleTimeString()}</span>
          </span>
        </>
      )}
      {!n && <span class="spark-empty faint tiny">collecting…</span>}
    </div>
  );
}

export function LoadLegend() {
  return (
    <div class="legend" aria-label="Load levels">
      {LEVELS.map((l) => (
        <span class={`legend-item ${lvlClass(l)}`}><span class="swatch" />{l.label} <span class="faint">{l.range}</span></span>
      ))}
    </div>
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Auto-refresh interval picker + manual refresh + "updated Xs ago". */
export function RefreshControl({ interval, setInterval: set, loading, updated, refresh }) {
  const now = useNow();
  const ago = updated ? Math.max(0, Math.round((now - updated) / 1000)) : null;
  return (
    <div class="refresh-control">
      <span class="small muted hide-sm">Auto-refresh</span>
      <div class="segmented" role="group" aria-label="Auto-refresh interval">
        {INTERVALS.map(([ms, label]) => (
          <button type="button" class={interval === ms ? 'on' : ''} aria-pressed={interval === ms} onClick={() => set(ms)}>{label}</button>
        ))}
      </div>
      <button type="button" class={`icon-btn ${loading ? 'spinning' : ''}`} aria-label="Refresh now" title="Refresh now" onClick={refresh}>
        <Icon name="restart" />
      </button>
      <span class="small faint updated" aria-live="polite">
        {ago == null ? 'Loading…' : ago < 2 ? 'Updated just now' : `Updated ${ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m`} ago`}
      </span>
    </div>
  );
}
