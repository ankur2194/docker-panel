import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, enc } from '../api.js';
import { Icon } from '../icons.jsx';
import { ErrorBanner, IconButton, StatusPill, useApp, useRefresh } from '../ui.jsx';
import { fmtPct } from '../load.js';
import { LoadPill } from '../monitor-ui.jsx';
import { NewProjectModal } from './NewProject.jsx';
import { DiscoverModal } from './Discover.jsx';

const FILTERS = [
  ['all', 'All'],
  ['running', 'Running'],
  ['partial', 'Partial'],
  ['stopped', 'Stopped'],
];

export function Dashboard() {
  const { runAction } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState(null);
  const [updated, setUpdated] = useState(0);
  const [host, setHost] = useState(null);

  const load = useCallback(async () => {
    api('GET', '/stats?host=1').then((s) => setHost(s.host), () => setHost(null));
    try {
      setData(await api('GET', '/projects'));
      setError('');
      setUpdated(Date.now());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  useRefresh(load);

  const projects = data?.projects || [];
  const count = (s) => projects.filter((p) => (s === 'stopped' ? p.state === 'stopped' || p.state === 'not-created' : p.state === s)).length;
  const up = projects.reduce((a, p) => a + p.running, 0);
  const total = projects.reduce((a, p) => a + p.total, 0);
  const q = query.trim().toLowerCase();
  const visible = projects.filter((p) =>
    (filter === 'all' || (filter === 'stopped' ? p.state === 'stopped' || p.state === 'not-created' : p.state === filter)) &&
    (!q || p.name.includes(q) || p.directory.toLowerCase().includes(q)));

  const act = (p, action) => {
    if (action === 'stop' && !confirm(`Stop all services of "${p.name}"?`)) return;
    runAction(p.id, action);
  };

  return (
    <main class="page">
      <div class="page-head">
        <div class="grow stack-6">
          <h1>Projects</h1>
          <p class="muted">Compose projects registered on this server, wherever they live on disk.</p>
        </div>
        <button type="button" class="btn" onClick={() => setModal('discover')}><Icon name="search" />Discover &amp; import</button>
        <button type="button" class="btn primary" onClick={() => setModal('new')}><Icon name="plus" />New project</button>
      </div>

      <ErrorBanner>{error || data?.dockerError}</ErrorBanner>

      <div class="stats">
        <div class="stat"><span>Projects</span><strong>{projects.length}</strong></div>
        <div class="stat"><span>Running</span><strong class="ok">{count('running')}</strong></div>
        <div class="stat"><span>Partially running · Stopped</span>
          <strong><span class="warn">{count('partial')}</span><span class="faint"> · </span><span class="off">{count('stopped')}</span></strong>
        </div>
        <div class="stat"><span>Containers up</span><strong>{up}<small class="faint"> / {total}</small></strong></div>
        <a class="stat stat-link" href="#/monitor" aria-label="Server load, open Monitor">
          <span class="row-6">Server load <Icon name="right" size={14} /></span>
          {host ? (
            <div class="server-tile">
              <span class="faint small">CPU</span><strong class="mono">{fmtPct(host.cpu)}</strong><LoadPill pct={host.cpu} />
              <span class="faint small">Mem</span><strong class="mono">{fmtPct((host.mem.used / host.mem.total) * 100)}</strong>
              <LoadPill pct={(host.mem.used / host.mem.total) * 100} />
            </div>
          ) : <strong class="faint">—</strong>}
        </a>
      </div>

      <section class="card">
        <div class="toolbar">
          <label class="search">
            <Icon name="search" />
            <input type="search" aria-label="Search projects" placeholder="Search by name or path" value={query}
              onInput={(e) => setQuery(e.currentTarget.value)} />
          </label>
          <div class="segmented" role="group" aria-label="Filter by status">
            {FILTERS.map(([k, label]) => (
              <button type="button" class={filter === k ? 'on' : ''} aria-pressed={filter === k} onClick={() => setFilter(k)}>
                {label} {k === 'all' ? projects.length : count(k)}
              </button>
            ))}
          </div>
          <div class="grow" />
          <span class="small faint hide-sm">{updated ? `Refreshed ${new Date(updated).toLocaleTimeString()}` : 'Loading…'}</span>
        </div>

        <div class="table projects-table">
          <div class="thead">
            <span>Project</span><span>Status</span><span>Containers</span><span>Compose files</span><span>Env files</span><span class="right">Actions</span>
          </div>
          {data && !projects.length && (
            <div class="empty">
              <p><strong>No projects yet.</strong></p>
              <p class="muted">Import the Compose projects already running on this server, or create a new one.</p>
              <div class="row-8 center">
                <button type="button" class="btn" onClick={() => setModal('discover')}>Discover &amp; import</button>
                <button type="button" class="btn primary" onClick={() => setModal('new')}>New project</button>
              </div>
            </div>
          )}
          {data && projects.length > 0 && !visible.length && <div class="empty muted">No projects match.</div>}
          {visible.map((p) => (
            <div class="trow" key={p.id}>
              <div class="cell-main">
                <a href={`#/p/${enc(p.id)}`} class="strong-link">{p.name}</a>
                <span class="mono small muted ellipsis" title={p.directory}>{p.directory}</span>
              </div>
              <div><StatusPill state={p.state} />{p.busy && <span class="small muted"> {p.busy}…</span>}</div>
              <span class="mono">{p.running}/{p.total}</span>
              <div class="chips">{p.composeFiles.map((f) => <span class="chip" title={f}>{f}</span>)}</div>
              <div class="chips">
                {p.envFiles.length ? p.envFiles.map((f) => <span class="chip" title={f}>{f}</span>) : <span class="faint small">none</span>}
              </div>
              <div class="actions">
                {p.state === 'running'
                  ? <IconButton icon="stop" label={`Stop ${p.name}`} onClick={() => act(p, 'stop')} />
                  : <IconButton icon="play" tone="ok" label={`Start ${p.name}`} onClick={() => act(p, 'start')} />}
                <IconButton icon="restart" label={`Restart ${p.name}`} onClick={() => act(p, 'restart')} disabled={!p.running} />
                <IconButton icon="rebuild" label={`Rebuild ${p.name}`} onClick={() => act(p, 'rebuild')} />
                <a href={`#/p/${enc(p.id)}`} class="icon-btn" aria-label={`Open ${p.name}`} title="Open"><Icon name="right" /></a>
              </div>
            </div>
          ))}
        </div>
      </section>

      {modal === 'new' && <NewProjectModal onClose={() => setModal(null)} />}
      {modal === 'discover' && <DiscoverModal onClose={() => setModal(null)} onDone={load} />}
    </main>
  );
}
