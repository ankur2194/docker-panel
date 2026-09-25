import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { listComposeProjects, parseJsonList, projectArgs, run } from './compose.js';

export const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const COMPOSE_FILE_RE = /\.ya?ml$/i;
export const ENV_FILE_RE = /(^\.env(\..+)?$)|(\.env$)/i;
const DEFAULT_COMPOSE = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const registryFile = () => path.join(config.dataDir, 'projects.json');
let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(registryFile(), 'utf8')).projects || [];
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    cache = [];
  }
  return cache;
}

async function save() {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = registryFile() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify({ projects: cache }, null, 2));
  await fs.rename(tmp, registryFile());
}

export async function all() {
  return [...(await load())];
}

export async function get(id) {
  const p = (await load()).find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'Project not found');
  return p;
}

/** Compose / env paths are stored relative to the project directory when inside it. */
function relTo(dir, file) {
  const abs = path.resolve(dir, file);
  const rel = path.relative(dir, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

function cleanList(v, re, what) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${what} must be a list`);
  return v.map((s) => {
    if (typeof s !== 'string' || !s.trim() || s.includes('\0')) throw new HttpError(400, `Invalid ${what}`);
    if (re && !re.test(s.trim())) throw new HttpError(400, `Invalid ${what}: ${s}`);
    return s.trim();
  });
}

function checkDirectory(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) {
    throw new HttpError(400, 'Directory must be an absolute path');
  }
  return path.resolve(dir);
}

export function defaultComposeFile(dir) {
  return DEFAULT_COMPOSE.find((f) => existsSync(path.join(dir, f)));
}

export async function register({ name, directory, composeFiles, envFiles, profiles, source = 'manual' }) {
  const list = await load();
  const dir = checkDirectory(directory);
  if (!NAME_RE.test(name || '')) throw new HttpError(400, 'Name must use lowercase letters, digits, "-" or "_"');
  if (list.some((p) => p.name === name)) throw new HttpError(409, `A project named "${name}" is already registered`);
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw new HttpError(400, `Directory not found: ${dir}`);

  let files = cleanList(composeFiles, COMPOSE_FILE_RE, 'compose file').map((f) => relTo(dir, f));
  if (!files.length) {
    const def = defaultComposeFile(dir);
    if (!def) throw new HttpError(400, `No compose file found in ${dir}`);
    files = [def];
  }
  for (const f of files) {
    if (!existsSync(path.resolve(dir, f))) throw new HttpError(400, `File not found: ${f}`);
  }
  let envs = cleanList(envFiles, null, 'env file').map((f) => relTo(dir, f));
  if (envFiles == null && existsSync(path.join(dir, '.env'))) envs = ['.env'];

  const project = {
    id: name,
    name,
    directory: dir,
    composeFiles: files,
    envFiles: envs,
    profiles: cleanList(profiles, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'profile'),
    source,
    createdAt: new Date().toISOString(),
  };
  list.push(project);
  await save();
  return project;
}

export async function update(id, patch) {
  const p = await get(id);
  if (patch.composeFiles !== undefined) {
    const files = cleanList(patch.composeFiles, COMPOSE_FILE_RE, 'compose file').map((f) => relTo(p.directory, f));
    if (!files.length) throw new HttpError(400, 'Select at least one compose file');
    for (const f of files) {
      if (!existsSync(path.resolve(p.directory, f))) throw new HttpError(400, `File not found: ${f}`);
    }
    p.composeFiles = files;
  }
  if (patch.envFiles !== undefined) {
    const envs = cleanList(patch.envFiles, null, 'env file').map((f) => relTo(p.directory, f));
    for (const f of envs) {
      if (!existsSync(path.resolve(p.directory, f))) throw new HttpError(400, `File not found: ${f}`);
    }
    p.envFiles = envs;
  }
  if (patch.profiles !== undefined) p.profiles = cleanList(patch.profiles, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, 'profile');
  await save();
  return p;
}

export async function remove(id) {
  servicesCache.delete(id);
  const list = await load();
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw new HttpError(404, 'Project not found');
  list.splice(i, 1);
  await save();
}

/** Create a brand new project directory with a compose file (and optional .env), then register it. */
export async function create({ name, directory, composeFile = 'compose.yml', compose, env }) {
  if (!NAME_RE.test(name || '')) throw new HttpError(400, 'Name must use lowercase letters, digits, "-" or "_"');
  if ((await load()).some((p) => p.name === name)) throw new HttpError(409, `A project named "${name}" is already registered`);
  const dir = checkDirectory(directory);
  if (!/^[\w.-]+\.ya?ml$/i.test(composeFile)) throw new HttpError(400, 'Invalid compose file name');
  if (typeof compose !== 'string' || !compose.trim()) throw new HttpError(400, 'Compose file content is required');
  const composePath = path.join(dir, composeFile);
  if (existsSync(composePath)) throw new HttpError(409, `${composePath} already exists. Use "Discover & import" instead.`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(composePath, compose.endsWith('\n') ? compose : compose + '\n');
  const envFiles = [];
  if (typeof env === 'string' && env.trim()) {
    const envPath = path.join(dir, '.env');
    if (!existsSync(envPath)) await fs.writeFile(envPath, env.endsWith('\n') ? env : env + '\n', { mode: 0o600 });
    envFiles.push('.env');
  }
  return register({ name, directory: dir, composeFiles: [composeFile], envFiles, source: 'created' });
}

function summarize(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const running = counts.running || 0;
  let state = 'stopped';
  if (!total) state = 'not-created';
  else if (running === total) state = 'running';
  else if (running > 0) state = 'partial';
  return { state, running, total };
}

/** Registered projects merged with live status from one `docker compose ls` call. */
export async function listWithStatus() {
  const projects = await all();
  let live = [];
  let dockerError = null;
  try {
    live = await listComposeProjects();
  } catch (e) {
    dockerError = e.message;
  }
  const byName = new Map(live.map((l) => [l.name, l]));
  return {
    dockerError,
    projects: projects.map((p) => {
      const l = byName.get(p.name);
      return { ...p, status: l?.status || '', ...summarize(l?.counts || {}) };
    }),
  };
}

async function findComposeDirs(root, depth, out) {
  if (defaultComposeFile(root)) {
    out.push(root);
    return;
  }
  if (depth <= 0) return;
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      await findComposeDirs(path.join(root, e.name), depth - 1, out);
    }
  }
}

export function nameFromDir(dir) {
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '') || 'project';
}

/** Compose projects Docker knows about plus directories under SCAN_ROOTS that are not registered yet. */
export async function discover() {
  const projects = await all();
  const names = new Set(projects.map((p) => p.name));
  const dirs = new Set(projects.map((p) => p.directory));
  const out = [];
  let dockerError = null;
  try {
    for (const l of await listComposeProjects()) {
      if (names.has(l.name) || !l.configFiles.length) continue;
      const directory = path.dirname(l.configFiles[0]);
      dirs.add(directory);
      out.push({ name: l.name, directory, composeFiles: l.configFiles, status: l.status, source: 'docker' });
    }
  } catch (e) {
    dockerError = e.message;
  }
  for (const root of config.scanRoots) {
    const found = [];
    await findComposeDirs(root, 2, found);
    for (const directory of found) {
      if (dirs.has(directory)) continue;
      dirs.add(directory);
      out.push({
        name: nameFromDir(directory),
        directory,
        composeFiles: [path.join(directory, defaultComposeFile(directory))],
        status: '',
        source: `scan ${root}`,
      });
    }
  }
  return { candidates: out, scanRoots: config.scanRoots, dockerError };
}

// `config --services` only changes with the compose/env files, but the project page polls every 5 s.
// Cache it per project, keyed by the compose flags and the files' mtimes and sizes. The TTL covers
// files reached indirectly (include:, extends:).
const servicesCache = new Map(); // id -> { key, at, result }
const SERVICES_TTL = 60_000;

async function configKey(p) {
  const files = [
    ...(p.composeFiles.length ? p.composeFiles : DEFAULT_COMPOSE),
    ...(p.envFiles.length ? p.envFiles : ['.env']),
  ];
  const stamps = await Promise.all(files.map((f) =>
    fs.stat(path.resolve(p.directory, f)).then((st) => `${st.mtimeMs}:${st.size}`, () => '-')));
  return JSON.stringify([projectArgs(p), stamps]);
}

async function configServices(p) {
  const key = await configKey(p);
  const hit = servicesCache.get(p.id);
  if (hit && hit.key === key && Date.now() - hit.at < SERVICES_TTL) return hit.result;
  const r = await run([...projectArgs(p), 'config', '--services'], { cwd: p.directory });
  const result = r.code === 0
    ? { services: r.stdout.split('\n').filter(Boolean), configError: null }
    : { services: [], configError: r.stderr.trim() };
  servicesCache.set(p.id, { key, at: Date.now(), result });
  return result;
}

/** Everything the project page needs: config, files on disk, services and containers. */
export async function details(id) {
  const p = await get(id);
  const args = projectArgs(p);
  const [ps, cfg, entries] = await Promise.all([
    run([...args, 'ps', '-a', '--format', 'json'], { cwd: p.directory }),
    configServices(p),
    fs.readdir(p.directory, { withFileTypes: true }).catch(() => []),
  ]);
  let containers = [];
  try {
    containers = ps.code === 0 ? parseJsonList(ps.stdout) : [];
  } catch {
    containers = [];
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  return {
    ...p,
    directoryExists: entries.length > 0 || existsSync(p.directory),
    availableComposeFiles: files.filter((f) => COMPOSE_FILE_RE.test(f)),
    availableEnvFiles: files.filter((f) => ENV_FILE_RE.test(f)),
    services: cfg.services,
    configError: cfg.configError,
    containers: containers.map((c) => ({
      name: c.Name,
      service: c.Service,
      image: c.Image,
      state: c.State,
      status: c.Status,
      health: c.Health || '',
      ports: (c.Publishers || [])
        .filter((x) => x.PublishedPort)
        .map((x) => `${x.URL && x.URL !== '0.0.0.0' ? x.URL + ':' : ''}${x.PublishedPort}→${x.TargetPort}/${x.Protocol}`)
        .filter((v, i, a) => a.indexOf(v) === i),
    })),
  };
}

/**
 * Resolve a file the panel may read or write for a project: a compose or env file inside the
 * project directory, or one of the files the project explicitly references.
 */
export function resolveProjectFile(p, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new HttpError(400, 'Missing file');
  const abs = path.resolve(p.directory, file);
  const base = path.basename(abs);
  if (!COMPOSE_FILE_RE.test(base) && !ENV_FILE_RE.test(base)) {
    throw new HttpError(400, 'Only compose (.yml/.yaml) and env files can be edited');
  }
  const rel = path.relative(p.directory, abs);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
  const referenced = [...p.composeFiles, ...p.envFiles].some((f) => path.resolve(p.directory, f) === abs);
  if (!inside && !referenced) throw new HttpError(400, 'File must be in the project directory');
  return abs;
}
