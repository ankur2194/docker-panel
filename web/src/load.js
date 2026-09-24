import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api } from './api.js';

/** Load levels shared by every meter, pill and chart. `max` is exclusive. */
export const LEVELS = [
  { key: 'light', label: 'Light', max: 25, range: '< 25%' },
  { key: 'normal', label: 'Normal', max: 60, range: '25–60%' },
  { key: 'high', label: 'High', max: 85, range: '60–85%' },
  { key: 'over', label: 'Overload', max: Infinity, range: '≥ 85%' },
];

export const levelOf = (pct) => (pct == null || Number.isNaN(pct) ? null : LEVELS.find((l) => pct < l.max));

/** The worst level among several percentages. */
export const worstLevel = (...pcts) =>
  pcts.map(levelOf).filter(Boolean).reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), null);

// ---------- formatting ----------

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
export function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  let i = 0;
  while (Math.abs(n) >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  return `${i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)} ${UNITS[i]}`;
}
export const fmtRate = (n) => (n == null ? '—' : `${fmtBytes(n)}/s`);
export const fmtPct = (n) => (n == null || Number.isNaN(n) ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n)}%`);
export function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// ---------- refresh interval ----------

export const INTERVALS = [[0, 'Off'], [2000, '2s'], [5000, '5s'], [10000, '10s'], [30000, '30s'], [60000, '1m']];
const INTERVAL_KEY = 'dp:monitor-interval';

/** The chosen auto-refresh interval, remembered in this browser. */
export function useRefreshInterval() {
  const [ms, setMs] = useState(() => {
    try {
      const raw = localStorage.getItem(INTERVAL_KEY);
      return raw !== null && INTERVALS.some(([x]) => x === Number(raw)) ? Number(raw) : 5000;
    } catch {
      return 5000;
    }
  });
  const set = (v) => {
    setMs(v);
    try { localStorage.setItem(INTERVAL_KEY, String(v)); } catch { /* storage unavailable */ }
  };
  return [ms, set];
}

// ---------- history (browser only, since the page was opened) ----------

export const HISTORY = 120;
const history = new Map(); // key -> [{ t, ...values }]

function push(key, t, values) {
  let list = history.get(key);
  if (!list) history.set(key, (list = []));
  if (list.length && list[list.length - 1].t === t) return;
  list.push({ t, ...values });
  if (list.length > HISTORY) list.splice(0, list.length - HISTORY);
}

export const historyOf = (key) => history.get(key) || [];

function record(data) {
  const t = data.at;
  const h = data.host;
  if (h) {
    push('host', t, {
      cpu: h.cpu,
      load: (h.load[0] / h.cores) * 100,
      mem: h.mem.total ? (h.mem.used / h.mem.total) * 100 : null,
      rx: h.net.rxRate,
      tx: h.net.txRate,
    });
  }
  for (const c of data.containers || []) if (c.running) push(`c:${c.name}`, t, { cpu: c.cpuPct, mem: c.memPct });
  for (const p of data.projects || []) push(`p:${p.name ?? ''}`, t, { cpu: p.cpuPct, mem: p.memPct });
}

/**
 * Poll /api/stats?<query> every `interval` ms (0 = only on demand). Requests never overlap:
 * the next one is scheduled when the previous one finishes. Paused while the tab is hidden.
 */
export function useStats(query, interval) {
  const [state, setState] = useState({ data: null, error: '', loading: true, updated: 0 });
  const inflight = useRef(null);

  // Callers that arrive while a request is running share it instead of starting another.
  const load = useCallback(() => {
    if (inflight.current) return inflight.current;
    setState((s) => ({ ...s, loading: true }));
    inflight.current = api('GET', `/stats?${query}`)
      .then((data) => {
        record(data);
        setState({ data, error: data.error || '', loading: false, updated: Date.now() });
      })
      .catch((e) => setState((s) => ({ ...s, error: e.message, loading: false })))
      .finally(() => { inflight.current = null; });
    return inflight.current;
  }, [query]);

  useEffect(() => {
    let alive = true, timer;
    const tick = async () => {
      const started = Date.now();
      if (document.visibilityState === 'visible') await load();
      // measured from the start of the request, so slow `docker stats` runs don't stretch the interval
      if (alive && interval) timer = setTimeout(tick, Math.max(500, interval - (Date.now() - started)));
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [load, interval]);

  return { ...state, refresh: load };
}
