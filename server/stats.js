import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseJsonList, run } from './compose.js';

// Live load sampling. Nothing runs in the background: every figure is taken when a client asks,
// and rates are computed against the previous sample (whoever asked for it).

const REAL_FS = /^(ext[234]|xfs|btrfs|zfs|f2fs|vfat|exfat|ntfs3?|jfs|reiserfs|bcachefs)$/;
const VIRTUAL_NIC = /^(lo|veth|docker|br-|virbr|ifb|cni|flannel|cali|vxlan|tunl|kube)/;

const rate = (now, prev, dt) => (prev === undefined || dt <= 0 ? null : Math.max(0, (now - prev) / dt));

// ---------- host ----------

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let prevCpu = null;
async function cpuPercent() {
  if (!prevCpu) {
    prevCpu = cpuTimes();
    await new Promise((r) => setTimeout(r, 300));
  }
  const now = cpuTimes();
  const dTotal = now.total - prevCpu.total;
  const dIdle = now.idle - prevCpu.idle;
  prevCpu = now;
  return dTotal > 0 ? Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)) : 0;
}

export async function memInfo() {
  try {
    const kv = {};
    for (const line of (await fs.readFile('/proc/meminfo', 'utf8')).split('\n')) {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      if (m) kv[m[1]] = Number(m[2]) * 1024;
    }
    const total = kv.MemTotal;
    const available = kv.MemAvailable ?? kv.MemFree + (kv.Buffers || 0) + (kv.Cached || 0);
    return { total, used: total - available, available, swapTotal: kv.SwapTotal || 0, swapUsed: (kv.SwapTotal || 0) - (kv.SwapFree || 0) };
  } catch {
    const total = os.totalmem();
    return { total, used: total - os.freemem(), available: os.freemem(), swapTotal: 0, swapUsed: 0 };
  }
}

async function disks(projectDirs) {
  let lines = [];
  try {
    lines = (await fs.readFile('/proc/mounts', 'utf8')).split('\n');
  } catch {
    lines = ['rootfs / rootfs rw 0 0'];
  }
  const byDevice = new Map();
  for (const line of lines) {
    const [device, rawMount, type, opts = ''] = line.split(' ');
    if (!device || !rawMount) continue;
    const mount = rawMount.replace(/\\040/g, ' ');
    if (mount !== '/' && (!REAL_FS.test(type) || opts.split(',').includes('ro'))) continue;
    const seen = byDevice.get(device);
    if (!seen || mount.length < seen.mount.length) byDevice.set(device, { device, mount, type });
  }
  if (![...byDevice.values()].some((d) => d.mount === '/')) byDevice.set('/', { device: 'rootfs', mount: '/', type: '' });

  const out = [];
  for (const d of byDevice.values()) {
    try {
      const s = await fs.statfs(d.mount);
      const size = s.blocks * s.bsize;
      if (!size) continue;
      const free = s.bavail * s.bsize;
      const used = size - s.bfree * s.bsize;
      out.push({ ...d, size, used, free, pct: (used / (used + free)) * 100, projects: [] });
    } catch { /* unreadable mount */ }
  }
  // Attach each project to the mount its directory lives on (longest matching prefix).
  for (const [name, dir] of projectDirs) {
    let best = null;
    for (const d of out) {
      const inside = d.mount === '/' || dir === d.mount || dir.startsWith(d.mount + path.sep);
      if (inside && (!best || d.mount.length > best.mount.length)) best = d;
    }
    best?.projects.push(name);
  }
  return out.sort((a, b) => a.mount.localeCompare(b.mount));
}

let prevNet = null;
async function network() {
  let rx = 0, tx = 0;
  const ifaces = [];
  try {
    for (const line of (await fs.readFile('/proc/net/dev', 'utf8')).split('\n').slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
      if (!m || VIRTUAL_NIC.test(m[1])) continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      rx += f[0];
      tx += f[8];
      ifaces.push(m[1]);
    }
  } catch {
    return { rx: null, tx: null, rxRate: null, txRate: null, interfaces: [] };
  }
  const at = Date.now();
  const dt = prevNet ? (at - prevNet.at) / 1000 : 0;
  const out = { rx, tx, rxRate: rate(rx, prevNet?.rx, dt), txRate: rate(tx, prevNet?.tx, dt), interfaces: ifaces };
  prevNet = { rx, tx, at };
  return out;
}

/** CPU, load, memory, swap, disks and network of the machine the panel runs on. */
export async function hostStats(projectDirs = []) {
  const [cpu, mem, disk, net] = await Promise.all([cpuPercent(), memInfo(), disks(projectDirs), network()]);
  return { hostname: os.hostname(), cores: os.cpus().length, uptime: os.uptime(), cpu, load: os.loadavg(), mem, disks: disk, net };
}

// ---------- containers ----------

const UNITS = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };

/** "12.3MiB" / "1.2kB" / "0B" -> bytes */
export function parseSize(s = '') {
  const m = /^([\d.]+)\s*([a-z]*)$/i.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * (UNITS[(m[2] || 'b').toLowerCase()] ?? 1);
}

/** "1.2kB / 3.4MB" -> [1200, 3400000] */
const parsePair = (s = '') => s.split('/').map((x) => parseSize(x));
const pct = (s = '') => (s.includes('--') ? null : parseFloat(s) || 0);
const label = (labels, key) => new RegExp(`(?:^|,)${key.replace(/\./g, '\\.')}=([^,]*)`).exec(labels || '')?.[1] || null;

const prevIo = new Map(); // container id -> last cumulative counters
const cpuLimits = new Map(); // container id -> cores (0 = unlimited)
let cache = null; // { at, data }
let inflight = null;

async function lookupCpuLimits(ids) {
  const missing = ids.filter((id) => !cpuLimits.has(id));
  if (!missing.length) return;
  const r = await run(['inspect', '--format', '{{.Id}} {{.HostConfig.NanoCpus}} {{.HostConfig.CpuQuota}} {{.HostConfig.CpuPeriod}}', ...missing], { timeout: 10000 });
  for (const line of r.stdout.split('\n')) {
    const [id, nano, quota, period] = line.trim().split(' ');
    if (!id) continue;
    let cores = Number(nano) / 1e9 || 0;
    if (!cores && Number(quota) > 0) cores = Number(quota) / (Number(period) || 100000);
    cpuLimits.set(id, cores);
  }
}

async function collect() {
  const [st, ps, mem] = await Promise.all([
    run(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}'], { timeout: 20000 }),
    run(['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeout: 10000 }),
    memInfo(),
  ]);
  if (ps.code !== 0) throw new Error(ps.stderr.trim() || 'docker ps failed');
  const stats = new Map();
  if (st.code === 0) for (const s of parseJsonList(st.stdout)) stats.set(s.ID || s.Container, s);
  const list = parseJsonList(ps.stdout);
  await lookupCpuLimits(list.filter((c) => c.State === 'running').map((c) => c.ID));

  const cores = os.cpus().length;
  const at = Date.now();
  const alive = new Set();
  const containers = list.map((c) => {
    alive.add(c.ID);
    const s = stats.get(c.ID);
    const base = {
      id: c.ID,
      name: c.Names,
      image: c.Image,
      state: c.State,
      status: c.Status,
      project: label(c.Labels, 'com.docker.compose.project'),
      service: label(c.Labels, 'com.docker.compose.service'),
    };
    if (!s || c.State !== 'running') return { ...base, running: false };
    const [memUsed, memLimit] = parsePair(s.MemUsage);
    const [netRx, netTx] = parsePair(s.NetIO);
    const [blkRead, blkWrite] = parsePair(s.BlockIO);
    const prev = prevIo.get(c.ID);
    const dt = prev ? (at - prev.at) / 1000 : 0;
    prevIo.set(c.ID, { netRx, netTx, blkRead, blkWrite, at });
    const cpu = pct(s.CPUPerc) ?? 0;
    const cpuLimit = cpuLimits.get(c.ID) || 0;
    return {
      ...base,
      running: true,
      cpu, // docker style: 100 = one core
      cpuLimit: cpuLimit || null,
      cpuPct: cpu / (cpuLimit || cores), // share of the limit, or of the whole host
      memUsed,
      memLimit,
      memPct: pct(s.MemPerc) ?? (memLimit ? (memUsed / memLimit) * 100 : 0),
      netRx, netTx, blkRead, blkWrite,
      netRxRate: rate(netRx, prev?.netRx, dt),
      netTxRate: rate(netTx, prev?.netTx, dt),
      blkReadRate: rate(blkRead, prev?.blkRead, dt),
      blkWriteRate: rate(blkWrite, prev?.blkWrite, dt),
      pids: Number(s.PIDs) || 0,
    };
  });
  for (const id of prevIo.keys()) if (!alive.has(id)) prevIo.delete(id);
  for (const id of cpuLimits.keys()) if (!alive.has(id)) cpuLimits.delete(id);
  return { at, cores, memTotal: mem.total, containers, error: st.code === 0 ? null : st.stderr.trim() || 'docker stats failed' };
}

/**
 * Stats for every container. `docker stats --no-stream` takes a second or two, so concurrent
 * callers share one run and results younger than 1.5 s are reused.
 */
export function containerStats() {
  if (inflight) return inflight;
  if (cache && Date.now() - cache.at < 1500) return Promise.resolve(cache.data);
  inflight = collect()
    .then((data) => {
      cache = { at: Date.now(), data };
      return data;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

const sum = (xs, k) => {
  let total = 0, any = false;
  for (const x of xs) if (x[k] != null) { total += x[k]; any = true; }
  return any ? total : null;
};

/** Group containers by Compose project; `registered` is the panel's project list. */
export function projectStats({ containers, cores, memTotal }, registered = []) {
  const groups = new Map();
  for (const p of registered) groups.set(p.name, { name: p.name, id: p.id, containers: [] });
  for (const c of containers) {
    const key = c.project ?? '';
    if (!groups.has(key)) groups.set(key, { name: c.project, id: null, standalone: !c.project, containers: [] });
    groups.get(key).containers.push(c);
  }
  return [...groups.values()].map((g) => {
    const up = g.containers.filter((c) => c.running);
    const cpu = sum(up, 'cpu') ?? 0;
    const memUsed = sum(up, 'memUsed') ?? 0;
    return {
      name: g.name,
      id: g.id,
      standalone: !!g.standalone,
      running: up.length,
      total: g.containers.length,
      cpu,
      cpuPct: cpu / cores,
      memUsed,
      memPct: memTotal ? (memUsed / memTotal) * 100 : 0,
      netRxRate: sum(up, 'netRxRate'),
      netTxRate: sum(up, 'netTxRate'),
      blkReadRate: sum(up, 'blkReadRate'),
      blkWriteRate: sum(up, 'blkWriteRate'),
      pids: sum(up, 'pids') ?? 0,
    };
  });
}
