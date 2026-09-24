import { useCallback, useEffect, useState } from 'preact/hooks';
import { api, enc } from '../api.js';
import { Icon } from '../icons.jsx';
import { ErrorBanner, IconButton, Menu, StatusPill, useApp, useRefresh } from '../ui.jsx';
import { ConfigTab, EnvTab, FilesTab, LogsTab } from './ProjectTabs.jsx';
import { ProjectMonitor } from './Monitor.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['config', 'Configuration'],
  ['env', 'Environment'],
  ['files', 'Files'],
  ['logs', 'Logs'],
  ['monitor', 'Monitoring'],
];

function containerState(c) {
  if (c.state === 'running') return c.health === 'unhealthy' ? 'partial' : 'running';
  if (c.state === 'exited' || c.state === 'dead') return 'stopped';
  return 'partial';
}

export function Project({ id, tab, arg }) {
  const { runAction, running } = useApp();
  const [p, setP] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setP(await api('GET', `/projects/${enc(id)}`));
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (tab !== 'overview') return;
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    return () => clearInterval(t);
  }, [tab, load]);
  useRefresh(load);

  if (!p) {
    return (
      <main class="page">
        <nav class="crumbs"><a href="#/">Projects</a> / {id}</nav>
        {error ? <ErrorBanner>{error}</ErrorBanner> : <p class="muted">Loading…</p>}
      </main>
    );
  }

  const up = p.containers.filter((c) => c.state === 'running').length;
  const total = p.containers.length;
  const state = !total ? 'not-created' : up === total ? 'running' : up ? 'partial' : 'stopped';
  const act = (action, opts) => runAction(p.id, action, opts);
  const confirmAct = (msg, action, opts) => confirm(msg) && act(action, opts);

  const unregister = async () => {
    if (!confirm(`Remove "${p.name}" from the panel?\n\nContainers and files are left untouched.`)) return;
    try {
      await api('DELETE', `/projects/${enc(p.id)}`);
      location.hash = '#/';
    } catch (e) {
      alert(e.message);
    }
  };

  return (
    <>
      <div class="project-head">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Projects</a> <span class="faint">/</span> <span>{p.name}</span></nav>
        <div class="page-head">
          <div class="grow stack-6 min0">
            <div class="row-12">
              <h1>{p.name}</h1>
              <StatusPill state={state}>{{ running: 'Running', partial: 'Partial', stopped: 'Stopped', 'not-created': 'Not created' }[state]} {total ? `${up}/${total}` : ''}</StatusPill>
              {p.busy && <span class="small muted">{p.busy}…</span>}
            </div>
            <span class="mono small muted path-line"><Icon name="folder" size={14} />{p.directory} · {p.composeFiles.join(' + ')}{p.envFiles.length ? ` · ${p.envFiles.join(' + ')}` : ''}</span>
          </div>
          <div class="head-actions">
            <button type="button" class="btn" disabled={running || state === 'running'} onClick={() => act('start')}><Icon name="play" />Start</button>
            <button type="button" class="btn" disabled={running || !up} onClick={() => confirmAct(`Stop all services of "${p.name}"?`, 'stop')}><Icon name="stop" />Stop</button>
            <button type="button" class="btn" disabled={running || !up} onClick={() => act('restart')}><Icon name="restart" />Restart</button>
            <div class="split">
              <button type="button" class="btn primary" disabled={running} onClick={() => act('rebuild')}><Icon name="rebuild" />Rebuild</button>
              <Menu label="Rebuild options" icon="down" buttonClass="btn primary split-toggle" items={[
                { label: 'Rebuild', hint: 'build, then up -d --force-recreate', onClick: () => act('rebuild') },
                { label: 'Rebuild, pull base images', hint: 'build --pull', onClick: () => act('rebuild', { pull: true }) },
                { label: 'Rebuild without cache', hint: 'build --no-cache --pull', onClick: () => act('rebuild', { pull: true, noCache: true }) },
              ]} />
            </div>
            <Menu label="More actions" buttonClass="btn icon-only" items={[
              { label: 'Pull & update', hint: 'pull images, then up -d', onClick: () => act('update') },
              { label: 'Down', hint: 'stop and remove containers & networks', danger: true,
                onClick: () => confirmAct(`Run "docker compose down" for "${p.name}"? Containers and networks are removed; named volumes are kept.`, 'down') },
              { label: 'Remove from panel', hint: 'containers and files stay', danger: true, onClick: unregister },
            ]} />
          </div>
        </div>
        <nav class="tabs" aria-label="Project sections">
          {TABS.map(([k, label]) => (
            <a href={`#/p/${enc(p.id)}/${k}`} class={tab === k ? 'on' : ''} aria-current={tab === k ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
      </div>
      <main class="page">
        <ErrorBanner>{error}</ErrorBanner>
        {p.configError && tab !== 'files' && (
          <ErrorBanner>{`docker compose config failed:\n${p.configError}`}</ErrorBanner>
        )}
        {tab === 'overview' && <Overview p={p} act={act} running={running} />}
        {tab === 'config' && <ConfigTab p={p} reload={load} />}
        {tab === 'env' && <EnvTab p={p} reload={load} initial={arg} />}
        {tab === 'files' && <FilesTab p={p} reload={load} initial={arg} />}
        {tab === 'logs' && <LogsTab p={p} initialService={arg} />}
        {tab === 'monitor' && <ProjectMonitor p={p} />}
      </main>
    </>
  );
}

function Overview({ p, act, running }) {
  const withContainer = new Set(p.containers.map((c) => c.service));
  const missing = p.services.filter((s) => !withContainer.has(s));
  return (
    <section class="card">
      <div class="card-head">
        <h2 class="grow">Services</h2>
        <span class="small faint">docker compose ps · auto-refreshes</span>
      </div>
      <div class="table services-table">
        <div class="thead"><span>Service</span><span>Image</span><span>State</span><span>Ports</span><span>Status</span><span class="right">Actions</span></div>
        {!p.containers.length && !missing.length && <div class="empty muted">No services found.</div>}
        {p.containers.map((c) => (
          <div class="trow" key={c.name}>
            <div class="cell-main"><strong>{c.service}</strong><span class="mono tiny faint">{c.name}</span></div>
            <span class="mono small ellipsis" title={c.image}>{c.image}</span>
            <div><StatusPill state={containerState(c)}>{c.state}{c.health ? ` · ${c.health}` : ''}</StatusPill></div>
            <span class="mono small">{c.ports.length ? c.ports.join(', ') : <span class="faint">none</span>}</span>
            <span class="small muted">{c.status}</span>
            <div class="actions">
              {c.state === 'running' ? (
                <>
                  <IconButton icon="restart" label={`Restart ${c.service}`} disabled={running} onClick={() => act('restart', { service: c.service })} />
                  <IconButton icon="stop" label={`Stop ${c.service}`} disabled={running} onClick={() => act('stop', { service: c.service })} />
                </>
              ) : (
                <IconButton icon="play" tone="ok" label={`Start ${c.service}`} disabled={running} onClick={() => act('start', { service: c.service })} />
              )}
              <a class="icon-btn" href={`#/p/${enc(p.id)}/logs/${enc(c.service)}`} aria-label={`Logs for ${c.service}`} title="Logs"><Icon name="terminal" /></a>
            </div>
          </div>
        ))}
        {missing.map((s) => (
          <div class="trow" key={s}>
            <div class="cell-main"><strong>{s}</strong><span class="tiny faint">no container</span></div>
            <span class="faint small">—</span>
            <div><StatusPill state="not-created" /></div>
            <span class="faint small">—</span>
            <span />
            <div class="actions">
              <IconButton icon="play" tone="ok" label={`Start ${s}`} disabled={running} onClick={() => act('start', { service: s })} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
