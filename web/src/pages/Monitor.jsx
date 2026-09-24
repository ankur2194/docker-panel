import { useState } from 'preact/hooks';
import { enc } from '../api.js';
import { Icon } from '../icons.jsx';
import { fmtBytes, fmtPct, fmtRate, fmtUptime, historyOf, useRefreshInterval, useStats, worstLevel } from '../load.js';
import { LoadLegend, LoadPill, Meter, RefreshControl, Sparkline } from '../monitor-ui.jsx';
import { ErrorBanner, StatusPill } from '../ui.jsx';

const series = (key, field) => historyOf(key).map((s) => ({ t: s.t, v: s[field] }));
const rowClass = (...pcts) => `trow row-lvl lvl-${worstLevel(...pcts)?.key || 'none'}`;

/** Card with a headline value, a level pill, a meter and a sparkline. */
function MetricCard({ title, value, sub, pct, chart, chartLabel }) {
  return (
    <div class="metric">
      <div class="metric-head">
        <span class="muted small">{title}</span>
        {pct != null && <LoadPill pct={pct} />}
      </div>
      <strong class="metric-value">{value}</strong>
      {sub && <span class="small muted">{sub}</span>}
      {pct != null && <Meter pct={pct} label={title} />}
      {chart && <Sparkline points={chart} label={chartLabel || title} />}
    </div>
  );
}

function IoPair({ a, b, labels = ['In', 'Out'] }) {
  return (
    <div class="io mono small">
      <span><span class="faint">{labels[0]}</span> {fmtRate(a)}</span>
      <span><span class="faint">{labels[1]}</span> {fmtRate(b)}</span>
    </div>
  );
}

function HostSection({ host }) {
  const memPct = host.mem.total ? (host.mem.used / host.mem.total) * 100 : null;
  const loadPct = (host.load[0] / host.cores) * 100;
  const swapPct = host.mem.swapTotal ? (host.mem.swapUsed / host.mem.swapTotal) * 100 : null;
  return (
    <section class="stack-12" aria-labelledby="mon-server">
      <div class="section-head">
        <h2 id="mon-server">Server</h2>
        <span class="small muted mono">{host.hostname} · {host.cores} cores · up {fmtUptime(host.uptime)}</span>
      </div>
      <div class="metric-grid">
        <MetricCard title="CPU" value={fmtPct(host.cpu)} sub={`across ${host.cores} cores`} pct={host.cpu} chart={series('host', 'cpu')} />
        <MetricCard title="Load average" value={host.load[0].toFixed(2)} pct={loadPct} chart={series('host', 'load')} chartLabel="Load per core"
          sub={`5m ${host.load[1].toFixed(2)} · 15m ${host.load[2].toFixed(2)} · ${fmtPct(loadPct)} per core`} />
        <MetricCard title="Memory" value={fmtPct(memPct)} pct={memPct} chart={series('host', 'mem')}
          sub={`${fmtBytes(host.mem.used)} of ${fmtBytes(host.mem.total)} · ${fmtBytes(host.mem.available)} available`} />
        {host.mem.swapTotal
          ? <MetricCard title="Swap" value={fmtPct(swapPct)} pct={swapPct} sub={`${fmtBytes(host.mem.swapUsed)} of ${fmtBytes(host.mem.swapTotal)}`} />
          : <MetricCard title="Swap" value="Off" sub="No swap configured" />}
        <div class="metric">
          <div class="metric-head"><span class="muted small">Network</span><span class="tiny faint mono ellipsis">{host.net.interfaces.join(', ')}</span></div>
          <div class="net-rows">
            <span class="small muted">In</span><strong class="mono">{fmtRate(host.net.rxRate)}</strong>
            <Sparkline points={series('host', 'rx')} label="Network in" pct={false} format={fmtRate} height={28} />
            <span class="small muted">Out</span><strong class="mono">{fmtRate(host.net.txRate)}</strong>
            <Sparkline points={series('host', 'tx')} label="Network out" pct={false} format={fmtRate} height={28} />
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2 class="grow">Disks</h2><span class="small faint">used space per filesystem</span></div>
        {host.disks.map((d) => (
          <div class="disk-row">
            <div class="cell-main">
              <strong class="mono">{d.mount}</strong>
              <span class="tiny faint mono">{d.device}{d.type ? ` · ${d.type}` : ''}</span>
            </div>
            <div class="stack-6 min0">
              <div class="row-8"><Meter pct={d.pct} label={`Disk ${d.mount}`} /><span class="mono small value-col">{fmtPct(d.pct)}</span></div>
              <span class="small muted">{fmtBytes(d.used)} used of {fmtBytes(d.used + d.free)} · {fmtBytes(d.free)} free</span>
            </div>
            <LoadPill pct={d.pct} />
            <div class="chips hide-sm">
              {d.projects.slice(0, 6).map((n) => <span class="chip">{n}</span>)}
              {d.projects.length > 6 && <span class="chip">+{d.projects.length - 6}</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SortToggle({ sort, setSort }) {
  return (
    <div class="segmented" role="group" aria-label="Sort by">
      {[['cpu', 'CPU'], ['mem', 'Memory'], ['name', 'Name']].map(([k, label]) => (
        <button type="button" class={sort === k ? 'on' : ''} aria-pressed={sort === k} onClick={() => setSort(k)}>{label}</button>
      ))}
    </div>
  );
}

const sorter = (sort, name) => (a, b) =>
  sort === 'name' ? name(a).localeCompare(name(b)) : sort === 'mem' ? (b.memUsed || 0) - (a.memUsed || 0) : (b.cpuPct || 0) - (a.cpuPct || 0);

function ProjectsTable({ projects }) {
  const [sort, setSort] = useState('cpu');
  const list = [...projects].sort(sorter(sort, (p) => p.name || '~'));
  return (
    <section class="card" aria-labelledby="mon-projects">
      <div class="card-head">
        <h2 id="mon-projects" class="grow">Projects</h2>
        <SortToggle sort={sort} setSort={setSort} />
      </div>
      <div class="table mon-projects-table">
        <div class="thead"><span>Project</span><span>Load</span><span>CPU</span><span>Memory</span><span>Network</span><span>Disk I/O</span><span class="right">Up</span></div>
        {!list.length && <div class="empty muted">No containers.</div>}
        {list.map((p) => (
          <div class={rowClass(p.cpuPct, p.memPct)} key={p.name ?? ''}>
            <div class="cell-main">
              {p.standalone
                ? <strong class="muted">Standalone containers</strong>
                : p.id
                  ? <a href={`#/p/${enc(p.id)}/monitor`} class="strong-link">{p.name}</a>
                  : <strong>{p.name}</strong>}
              {!p.standalone && !p.id && <span class="tiny faint">not in panel</span>}
            </div>
            <LoadPill level={worstLevel(p.cpuPct, p.memPct)} />
            <UsageCell pct={p.cpuPct} text={fmtPct(p.cpuPct)} sub={`${(p.cpu / 100).toFixed(2)} CPUs`} chart={series(`p:${p.name ?? ''}`, 'cpu')} label={`${p.name || 'Standalone'} CPU`} />
            <UsageCell pct={p.memPct} text={fmtBytes(p.memUsed)} sub={`${fmtPct(p.memPct)} of RAM`} chart={series(`p:${p.name ?? ''}`, 'mem')} label={`${p.name || 'Standalone'} memory`} />
            <IoPair a={p.netRxRate} b={p.netTxRate} />
            <IoPair a={p.blkReadRate} b={p.blkWriteRate} labels={['Read', 'Write']} />
            <span class="mono right">{p.running}/{p.total}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function UsageCell({ pct, text, sub, chart, label }) {
  return (
    <div class="usage">
      <div class="usage-top"><strong class="mono">{text}</strong><span class="tiny faint ellipsis">{sub}</span></div>
      <Meter pct={pct} label={label} />
      {chart && <Sparkline points={chart} label={label} height={22} />}
    </div>
  );
}

/** Per-container load. `showProject` adds the project name under each container. */
export function ContainersTable({ containers, cores, memTotal, showProject = true, title = 'Containers' }) {
  const [sort, setSort] = useState('cpu');
  const [q, setQ] = useState('');
  const [stopped, setStopped] = useState(false);
  const running = containers.filter((c) => c.running).length;
  const needle = q.trim().toLowerCase();
  const list = containers
    .filter((c) => (stopped || c.running) && (!needle || [c.name, c.project, c.service, c.image].some((s) => s?.toLowerCase().includes(needle))))
    .sort((a, b) => (b.running - a.running) || sorter(sort, (c) => c.name)(a, b));
  return (
    <section class="card" aria-label={title}>
      <div class="toolbar">
        <h2>{title}</h2>
        <span class="small muted">{running} running{containers.length > running ? ` · ${containers.length - running} stopped` : ''}</span>
        <div class="grow" />
        <label class="search sm">
          <Icon name="search" />
          <input type="search" aria-label="Filter containers" placeholder="Filter" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
        </label>
        <label class="row-8 small"><input type="checkbox" checked={stopped} onChange={(e) => setStopped(e.currentTarget.checked)} />Show stopped</label>
        <SortToggle sort={sort} setSort={setSort} />
      </div>
      <div class="table mon-containers-table">
        <div class="thead"><span>Container</span><span>Load</span><span>CPU</span><span>Memory</span><span>Network</span><span>Disk I/O</span><span class="right">PIDs</span></div>
        {!list.length && <div class="empty muted">{containers.length ? 'No containers match.' : 'No containers.'}</div>}
        {list.map((c) => {
          const main = (
            <div class="cell-main">
              <strong class="ellipsis" title={c.name}>{c.service || c.name}</strong>
              <span class="tiny faint mono ellipsis" title={c.image}>
                {c.service ? c.name : c.image}{showProject && c.project ? ` · ${c.project}` : ''}
              </span>
            </div>
          );
          if (!c.running) {
            return (
              <div class="trow row-lvl lvl-none" key={c.id}>
                {main}
                <div><StatusPill state="stopped">{c.state}</StatusPill></div>
                <span class="small faint status-span">{c.status}</span>
              </div>
            );
          }
          const unlimitedMem = !c.memLimit || (memTotal && c.memLimit >= memTotal * 0.98);
          return (
            <div class={rowClass(c.cpuPct, c.memPct)} key={c.id}>
              {main}
              <LoadPill level={worstLevel(c.cpuPct, c.memPct)} />
              <UsageCell pct={c.cpuPct} text={fmtPct(c.cpuPct)} label={`${c.name} CPU`}
                sub={`${(c.cpu / 100).toFixed(2)} of ${c.cpuLimit ? `${+c.cpuLimit.toFixed(2)} (limit)` : cores} CPUs`} chart={series(`c:${c.name}`, 'cpu')} />
              <UsageCell pct={c.memPct} text={fmtBytes(c.memUsed)} label={`${c.name} memory`}
                sub={unlimitedMem ? `${fmtPct(c.memPct)} of RAM` : `${fmtPct(c.memPct)} of ${fmtBytes(c.memLimit)} limit`} chart={series(`c:${c.name}`, 'mem')} />
              <IoPair a={c.netRxRate} b={c.netTxRate} />
              <IoPair a={c.blkReadRate} b={c.blkWriteRate} labels={['Read', 'Write']} />
              <span class="mono right">{c.pids}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Monitor() {
  const [interval, setIntervalMs] = useRefreshInterval();
  const s = useStats('host=1&containers=1', interval);
  const d = s.data;
  return (
    <main class="page">
      <div class="page-head">
        <div class="grow stack-6">
          <h1>Monitor</h1>
          <p class="muted">Live load of this server, its Compose projects and containers. Collected only while this page is open.</p>
        </div>
        <RefreshControl interval={interval} setInterval={setIntervalMs} loading={s.loading} updated={s.updated} refresh={s.refresh} />
      </div>
      <LoadLegend />
      <ErrorBanner>{s.error}</ErrorBanner>
      {!d && !s.error && <p class="muted">Loading…</p>}
      {d?.host && <HostSection host={d.host} />}
      {d?.projects && <ProjectsTable projects={d.projects.filter((p) => p.total || p.id)} />}
      {d?.containers && <ContainersTable containers={d.containers} cores={d.cores} memTotal={d.memTotal} />}
    </main>
  );
}

/** Monitoring tab of a project page. */
export function ProjectMonitor({ p }) {
  const [interval, setIntervalMs] = useRefreshInterval();
  const s = useStats(`project=${enc(p.id)}`, interval);
  const t = s.data?.projects?.[0];
  const key = `p:${p.name}`;
  return (
    <div class="stack-16">
      <div class="row-12 wrap">
        <LoadLegend />
        <div class="grow" />
        <RefreshControl interval={interval} setInterval={setIntervalMs} loading={s.loading} updated={s.updated} refresh={s.refresh} />
      </div>
      <ErrorBanner>{s.error}</ErrorBanner>
      {!s.data && !s.error && <p class="muted">Loading…</p>}
      {t && (
        <div class="metric-grid">
          <MetricCard title="CPU" value={fmtPct(t.cpuPct)} pct={t.cpuPct} chart={series(key, 'cpu')}
            sub={`${(t.cpu / 100).toFixed(2)} of ${s.data.cores} host CPUs`} />
          <MetricCard title="Memory" value={fmtBytes(t.memUsed)} pct={t.memPct} chart={series(key, 'mem')}
            sub={`${fmtPct(t.memPct)} of ${fmtBytes(s.data.memTotal)} RAM`} />
          <div class="metric">
            <div class="metric-head"><span class="muted small">Network</span></div>
            <IoPair a={t.netRxRate} b={t.netTxRate} />
            <div class="metric-head"><span class="muted small">Disk I/O</span></div>
            <IoPair a={t.blkReadRate} b={t.blkWriteRate} labels={['Read', 'Write']} />
          </div>
          <div class="metric">
            <div class="metric-head"><span class="muted small">Containers</span>
              {t.total > 0 && <StatusPill state={t.running === t.total ? 'running' : t.running ? 'partial' : 'stopped'} />}
            </div>
            <strong class="metric-value">{t.running}<span class="faint"> / {t.total}</span></strong>
            <span class="small muted">{t.pids} processes</span>
          </div>
        </div>
      )}
      {s.data?.containers && (
        <ContainersTable containers={s.data.containers} cores={s.data.cores} memTotal={s.data.memTotal} showProject={false} title="Services" />
      )}
    </div>
  );
}

