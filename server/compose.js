import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.js';

// Compose lets shell variables override --env-file values, so the panel's own settings (PORT, ...)
// must not leak into projects. Only pass through what docker itself needs.
const PASS_ENV = /^(PATH|HOME|USER|LANG|LC_\w+|TZ|TMPDIR|XDG_\w+|SSH_AUTH_SOCK|DOCKER_\w+|BUILDKIT_\w+|(https?|no|all)_proxy)$/i;
const CHILD_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => PASS_ENV.test(k))),
  COMPOSE_ANSI: 'never',
  BUILDKIT_PROGRESS: 'plain',
  NO_COLOR: '1',
};

export const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

const resolveIn = (dir, f) => (path.isAbsolute(f) ? f : path.resolve(dir, f));

/** Global `docker compose` flags for a registered project. */
export function projectArgs(p) {
  const args = ['compose', '-p', p.name, '--project-directory', p.directory];
  for (const f of p.composeFiles || []) args.push('-f', resolveIn(p.directory, f));
  for (const f of p.envFiles || []) args.push('--env-file', resolveIn(p.directory, f));
  for (const pr of p.profiles || []) args.push('--profile', pr);
  return args;
}

/** Human readable command line (display only; never executed through a shell). */
export function commandLine(args) {
  return [config.dockerBin, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Run docker and collect output. Never throws; resolves { code, stdout, stderr }. */
export function run(args, { cwd, timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(config.dockerBin, args, { cwd, env: CHILD_ENV });
    } catch (e) {
      return resolve({ code: -1, stdout, stderr: e.message });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Spawn docker and hand every output chunk to onData. Returns the child process.
 * Backpressure: when onData returns false (the client's socket buffer is full), output is paused
 * until `res` drains, so a slow reader never makes the server buffer a whole log or build in memory.
 * If `res` closes instead, output resumes (and is discarded by the caller) so the process can finish.
 */
export function stream(args, { cwd, onData, onExit, res }) {
  const child = spawn(config.dockerBin, args, { cwd, env: CHILD_ENV });
  let paused = false;
  const resume = () => {
    if (!paused) return;
    paused = false;
    child.stdout.resume();
    child.stderr.resume();
  };
  const onChunk = (d) => {
    if (onData(d) === false && res && !res.destroyed && !paused) {
      paused = true;
      child.stdout.pause();
      child.stderr.pause();
      res.once('drain', resume);
    }
  };
  if (res) res.once('close', resume);
  child.stdout.setEncoding('utf8'); // keeps multi-byte characters whole across chunks
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  child.on('error', (e) => onData(`\n${e.message}\n`));
  child.on('close', (code) => {
    res?.off('drain', resume);
    res?.off('close', resume);
    onExit(code ?? -1);
  });
  return child;
}

/**
 * Compose steps for each panel action. Each step is the argv tail after the project flags.
 * opts: { services: string[], pull, noCache, recreate: 'force' | 'no' }
 * `start` is resolved separately (startSteps), since it depends on which containers exist.
 */
export function actionSteps(action, opts = {}) {
  const svc = opts.services || [];
  switch (action) {
    case 'up': {
      const flag = { force: ['--force-recreate'], no: ['--no-recreate'] }[opts.recreate] || [];
      return [['up', '-d', '--remove-orphans', ...flag, ...svc]];
    }
    case 'stop':
      return [['stop', ...svc]];
    case 'restart':
      return [['restart', ...svc]];
    case 'down':
      return [['down', '--remove-orphans']];
    case 'pull':
      return [['pull', ...svc]];
    case 'update': // pull newer images and recreate what changed
      return [['pull', ...svc], ['up', '-d', '--remove-orphans', ...svc]];
    case 'rebuild': {
      const build = ['build'];
      if (opts.pull) build.push('--pull');
      if (opts.noCache) build.push('--no-cache');
      return [[...build, ...svc], ['up', '-d', '--force-recreate', '--remove-orphans', ...svc]];
    }
    default:
      return null;
  }
}

/**
 * Start without recreating: `start` the services that already have containers, and create only the
 * missing ones. --no-recreate keeps `up` from recreating their depends_on services as a side effect.
 */
export async function startSteps(p, services = []) {
  const base = projectArgs(p);
  const [cfg, ps] = await Promise.all([
    services.length ? null : run([...base, 'config', '--services'], { cwd: p.directory }),
    run([...base, 'ps', '-a', '--format', '{{.Service}}'], { cwd: p.directory }),
  ]);
  if (cfg && cfg.code !== 0) throw Object.assign(new Error(cfg.stderr.trim() || 'docker compose config failed'), { status: 422 });
  if (ps.code !== 0) throw Object.assign(new Error(ps.stderr.trim() || 'docker compose ps failed'), { status: 502 });
  const targets = services.length ? services : cfg.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const existing = new Set(ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  const have = targets.filter((s) => existing.has(s));
  const missing = targets.filter((s) => !existing.has(s));
  const steps = [];
  if (have.length) steps.push(['start', ...have]);
  if (missing.length) steps.push(['up', '-d', '--no-recreate', ...missing]);
  return steps;
}

// ---------- system-wide clean-up ----------

export const PRUNE_UNTIL = ['', '24h', '168h', '720h'];

/** argv for a prune, built only from whitelisted flags. Returns null for an unknown target. */
export function pruneArgs({ target, all = false, volumes = false, until = '' }) {
  const cmd = { builder: ['builder', 'prune'], images: ['image', 'prune'], containers: ['container', 'prune'],
    networks: ['network', 'prune'], volumes: ['volume', 'prune'], system: ['system', 'prune'] }[target];
  if (!cmd) return null;
  const args = [...cmd, '-f'];
  if (all && ['builder', 'volumes'].includes(target)) args.push('--all');
  if (all && ['images', 'system'].includes(target)) args.push('-a');
  if (volumes && target === 'system') args.push('--volumes');
  if (until) args.push('--filter', `until=${until}`);
  return args;
}

/** `docker system df` rows: Images, Containers, Local Volumes, Build Cache. */
export async function diskUsage() {
  const r = await run(['system', 'df', '--format', '{{json .}}'], { timeout: 60000 });
  if (r.code !== 0) throw Object.assign(new Error(r.stderr.trim() || 'docker system df failed'), { status: 502 });
  return parseJsonList(r.stdout).map((x) => ({
    type: x.Type, total: Number(x.TotalCount) || 0, active: Number(x.Active) || 0, size: x.Size, reclaimable: x.Reclaimable,
  }));
}

/** Parse `docker compose ls` / `ps` JSON, which is either an array or one object per line. */
export function parseJsonList(text) {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** "running(2), exited(1)" -> { running: 2, exited: 1 } */
export function parseStatus(s = '') {
  const out = {};
  for (const m of s.matchAll(/(\w+)\((\d+)\)/g)) out[m[1]] = Number(m[2]);
  return out;
}

let lsCache = null; // { at, data }
let lsInflight = null;
let lsGen = 0;

/** Drop the cached `compose ls` result (after an action changed what is running). */
export function invalidateComposeLs() {
  lsCache = null;
  lsInflight = null; // a run that started before the change must not be shared or cached
  lsGen++;
}

/**
 * `docker compose ls -a`. Every open dashboard polls this, so concurrent callers share one run
 * and results younger than 2 s are reused.
 */
export function listComposeProjects() {
  if (lsInflight) return lsInflight;
  if (lsCache && Date.now() - lsCache.at < 2000) return Promise.resolve(lsCache.data);
  const gen = lsGen;
  const p = (async () => {
    const r = await run(['compose', 'ls', '-a', '--format', 'json']);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'docker compose ls failed');
    const data = parseJsonList(r.stdout).map((x) => ({
      name: x.Name,
      status: x.Status,
      counts: parseStatus(x.Status),
      configFiles: (x.ConfigFiles || '').split(',').map((s) => s.trim()).filter(Boolean),
    }));
    if (gen === lsGen) lsCache = { at: Date.now(), data };
    return data;
  })().finally(() => { if (lsInflight === p) lsInflight = null; });
  lsInflight = p;
  return p;
}

export async function versions() {
  const [d, c] = await Promise.all([
    run(['version', '--format', '{{.Server.Version}}'], { timeout: 5000 }),
    run(['compose', 'version', '--short'], { timeout: 5000 }),
  ]);
  return {
    docker: d.code === 0 ? d.stdout.trim() : null,
    compose: c.code === 0 ? c.stdout.trim() : null,
    error: d.code === 0 ? null : (d.stderr.trim() || 'Docker is not reachable'),
  };
}
