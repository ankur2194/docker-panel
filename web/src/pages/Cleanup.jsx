import { useCallback, useEffect, useState } from 'preact/hooks';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { ErrorBanner, useApp, useRefresh } from '../ui.jsx';

const AGES = [['', 'Any age'], ['24h', 'Older than 24 hours'], ['168h', 'Older than 7 days'], ['720h', 'Older than 30 days']];

/**
 * What each clean-up removes. `all` / `volumes` describe the optional flags; `df` is the matching
 * `docker system df` row; `ages: false` where Docker cannot filter by age.
 */
const TARGETS = [
  {
    key: 'builder', title: 'Build cache', df: 'Build Cache', cmd: 'builder prune -f',
    about: 'Layers and cache left by image builds. Only unused cache is removed unless you include all of it.',
    all: { flag: '--all', label: 'All build cache, including cache still referenced by images' },
  },
  {
    key: 'images', title: 'Images', df: 'Images', cmd: 'image prune -f',
    about: 'Dangling images (untagged leftovers of rebuilds). Images used by a container, running or stopped, are always kept.',
    all: { flag: '-a', label: 'Every image not used by a container, not only dangling ones' },
  },
  {
    key: 'containers', title: 'Stopped containers', df: 'Containers', cmd: 'container prune -f',
    about: 'All stopped containers. Compose recreates them on the next Start, so a project\'s stopped services come back fresh.',
  },
  {
    key: 'networks', title: 'Networks', cmd: 'network prune -f',
    about: 'Networks no container is connected to.',
  },
  {
    key: 'volumes', title: 'Volumes', df: 'Local Volumes', cmd: 'volume prune -f', danger: true, ages: false,
    about: 'Volumes no container uses. Only anonymous volumes are removed unless you include named ones. Data in them is lost.',
    all: { flag: '--all', label: 'Named volumes too (database data, uploads, …)', danger: true },
  },
  {
    key: 'system', title: 'Everything unused', cmd: 'system prune -f',
    about: 'Stopped containers, unused networks, dangling images and unused build cache in one go.',
    all: { flag: '-a', label: 'Every unused image, not only dangling ones' },
    volumes: { flag: '--volumes', label: 'Anonymous volumes too', danger: true },
  },
];

function commandFor(t, o) {
  const parts = ['docker', t.cmd];
  if (o.all && t.all) parts.push(t.all.flag);
  if (o.volumes && t.volumes) parts.push(t.volumes.flag);
  if (o.until) parts.push(`--filter until=${o.until}`);
  return parts.join(' ');
}

function PruneCard({ t, row, busy, onRun }) {
  const [o, setO] = useState({ all: false, volumes: false, until: '' });
  const set = (k, v) => setO((prev) => ({ ...prev, [k]: v, ...(k === 'volumes' && v ? { until: '' } : {}) }));
  const noAge = t.ages === false || (t.volumes && o.volumes);
  const dangerous = t.danger || (o.all && t.all?.danger) || (o.volumes && t.volumes?.danger);
  const id = `prune-${t.key}`;
  return (
    <section class={`card prune-card ${dangerous ? 'danger' : ''}`} aria-labelledby={id}>
      <div class="prune-body">
        <div class="row-8">
          <h2 id={id} class="grow">{t.title}</h2>
          {row && <span class="small muted mono" title="Reclaimable, as reported by docker system df">{row.reclaimable} reclaimable</span>}
        </div>
        <p class="small muted">{t.about}</p>
        <div class="stack-6">
          {t.all && (
            <label class={`check small ${t.all.danger ? 'err' : ''}`}>
              <input type="checkbox" checked={o.all} onChange={(e) => set('all', e.currentTarget.checked)} />
              {t.all.label}
            </label>
          )}
          {t.volumes && (
            <label class={`check small ${t.volumes.danger ? 'err' : ''}`}>
              <input type="checkbox" checked={o.volumes} onChange={(e) => set('volumes', e.currentTarget.checked)} />
              {t.volumes.label}
            </label>
          )}
          {t.ages !== false && (
            <label class="row-8 small">
              <span class="muted">Age</span>
              <select class="sm-select" value={o.until} disabled={noAge} onChange={(e) => set('until', e.currentTarget.value)}
                title={noAge ? 'Docker cannot filter volumes by age' : ''}>
                {AGES.map(([v, label]) => <option value={v}>{label}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>
      <div class="prune-foot">
        <code class="mono small ellipsis grow" title={commandFor(t, o)}>{commandFor(t, o)}</code>
        <button type="button" class={`btn sm ${dangerous ? 'danger-btn' : ''}`} disabled={busy} onClick={() => onRun(t, o)}>
          <Icon name="trash" />Clean up
        </button>
      </div>
    </section>
  );
}

export function Cleanup() {
  const { runStream, running } = useApp();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows((await api('GET', '/system/df')).rows);
      setError('');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefresh(load);

  const run = (t, o) => {
    const lost = [];
    if (t.key === 'volumes' || (t.volumes && o.volumes)) lost.push(o.all && t.key === 'volumes' ? 'named and anonymous volumes' : 'anonymous volumes');
    const msg = `Run "${commandFor(t, o)}"?\n\n${t.about}${lost.length ? `\n\nData in unused ${lost.join(' and ')} is deleted permanently.` : ''}`;
    if (!confirm(msg)) return;
    runStream('/system/prune', { target: t.key, all: o.all, volumes: o.volumes, until: o.until }, `Clean up ${t.title.toLowerCase()}`);
  };

  const byType = new Map((rows || []).map((r) => [r.type, r]));

  return (
    <main class="page">
      <div class="page-head">
        <div class="grow stack-6">
          <h1>Cleanup</h1>
          <p class="muted">Free disk space by removing Docker build cache, images, containers, networks and volumes nothing uses.</p>
        </div>
        <button type="button" class={`btn ${loading ? 'spinning' : ''}`} onClick={load} disabled={loading}><Icon name="restart" />Refresh</button>
      </div>
      <ErrorBanner>{error}</ErrorBanner>

      <section class="card">
        <div class="card-head"><h2 class="grow">Disk usage</h2><span class="small faint">docker system df</span></div>
        <div class="table df-table">
          <div class="thead"><span>Type</span><span class="right">Total</span><span class="right">In use</span><span class="right">Size</span><span class="right">Reclaimable</span></div>
          {!rows && <div class="empty muted">{loading ? 'Measuring… this can take a moment on busy hosts.' : 'Not available.'}</div>}
          {rows?.map((r) => (
            <div class="trow">
              <strong>{r.type}</strong>
              <span class="mono right">{r.total}</span>
              <span class="mono right">{r.active}</span>
              <span class="mono right">{r.size}</span>
              <span class="mono right">{r.reclaimable}</span>
            </div>
          ))}
        </div>
      </section>

      <div class="prune-grid">
        {TARGETS.map((t) => <PruneCard t={t} row={t.df && byType.get(t.df)} busy={running} onRun={run} />)}
      </div>
    </main>
  );
}
