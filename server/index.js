import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, warnings } from './config.js';
import * as auth from './auth.js';
import * as projects from './projects.js';
import { HttpError } from './projects.js';
import {
  actionSteps, commandLine, diskUsage, projectArgs, PRUNE_UNTIL, pruneArgs, run, SERVICE_RE, startSteps, stream, versions,
} from './compose.js';
import { containerStats, hostStats, projectStats } from './stats.js';

for (const w of warnings) console.warn(`[docker-panel] ${w}`);

const MAX_BODY = 2 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const busy = new Map(); // project id -> running action name
let pruning = false;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(json);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** Newline-delimited JSON stream: {"t":"out","d":"..."} lines, then {"t":"exit","code":0}. */
function ndjson(res) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  return (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
}

function clientIp(req) {
  return req.socket.remoteAddress || '';
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler, { open = false } = {}) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, open });

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (auth.loginBlocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
  const { email, password } = await readBody(req);
  if (!(await auth.checkCredentials(email, password))) {
    auth.recordFailure(ip);
    return send(res, 401, { error: 'Incorrect email or password.' });
  }
  auth.clearFailures(ip);
  send(res, 200, { email: config.adminEmail }, { 'Set-Cookie': auth.sessionCookie(req, auth.createSession(config.adminEmail)) });
}, { open: true });

route('POST', '/api/logout', async (req, res) => send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() }), { open: true });

route('GET', '/api/me', async (req, res, { user }) => send(res, 200, { email: user.email }));

route('GET', '/api/info', async (req, res) => {
  send(res, 200, {
    hostname: os.hostname(),
    ...(await versions()),
    defaultProjectsDir: config.defaultProjectsDir,
    scanRoots: config.scanRoots,
  });
});

// Live load: ?host=1 (cheap, /proc only) and/or ?containers=1 (runs docker stats); ?project=<id> narrows containers.
route('GET', '/api/stats', async (req, res, { query }) => {
  const registered = await projects.all();
  const out = { at: Date.now() };
  const only = query.get('project');
  const project = only ? await projects.get(only) : null;
  const [host, docker] = await Promise.all([
    query.get('host') === '1' ? hostStats(registered.map((p) => [p.name, p.directory])) : null,
    query.get('containers') === '1' || only ? containerStats() : null,
  ]);
  if (host) out.host = host;
  if (docker) {
    const list = project ? docker.containers.filter((c) => c.project === project.name) : docker.containers;
    out.cores = docker.cores;
    out.memTotal = docker.memTotal;
    out.containers = list;
    out.projects = projectStats({ ...docker, containers: list }, project ? [project] : registered);
    if (docker.error) out.error = docker.error;
  }
  send(res, 200, out);
});

route('GET', '/api/projects', async (req, res) => {
  const data = await projects.listWithStatus();
  send(res, 200, { ...data, projects: data.projects.map((p) => ({ ...p, busy: busy.get(p.id) || null })) });
});

route('POST', '/api/projects', async (req, res) => send(res, 201, await projects.create(await readBody(req))));

route('GET', '/api/discover', async (req, res) => send(res, 200, await projects.discover()));

route('POST', '/api/projects/import', async (req, res) => {
  const body = await readBody(req);
  const directory = typeof body.directory === 'string' ? body.directory.trim() : body.directory;
  const name = body.name || (typeof directory === 'string' ? projects.nameFromDir(directory) : '');
  send(res, 201, await projects.register({ ...body, name, directory, source: body.source === 'docker' ? 'docker' : 'manual' }));
});

route('GET', '/api/projects/:id', async (req, res, { params }) => {
  const d = await projects.details(params.id);
  send(res, 200, { ...d, busy: busy.get(d.id) || null, command: commandLine(projectArgs(d)) });
});

route('PATCH', '/api/projects/:id', async (req, res, { params }) => send(res, 200, await projects.update(params.id, await readBody(req))));

route('DELETE', '/api/projects/:id', async (req, res, { params }) => {
  if (busy.has(params.id)) throw new HttpError(409, 'An action is running for this project');
  await projects.remove(params.id);
  send(res, 200, { ok: true });
});

/** Run docker argv lists one after another, streaming output as NDJSON; stops at the first failure. */
async function streamSteps(res, steps, cwd) {
  const write = ndjson(res);
  const started = Date.now();
  let code = 0;
  for (const args of steps) {
    write({ t: 'cmd', d: commandLine(args) });
    // Keeps running if the browser disconnects; compose operations should not be cut in half.
    code = await new Promise((resolve) => {
      try {
        stream(args, { cwd, onData: (d) => write({ t: 'out', d }), onExit: resolve });
      } catch (e) {
        write({ t: 'out', d: e.message + '\n' });
        resolve(-1);
      }
    });
    if (code !== 0) break;
  }
  write({ t: 'exit', code, ms: Date.now() - started });
  res.end();
}

function serviceList(opts) {
  const list = opts.services ?? [];
  if (!Array.isArray(list) || list.length > 200) throw new HttpError(400, 'services must be a list of service names');
  const all = opts.service ? [...list, opts.service] : list;
  for (const s of all) if (typeof s !== 'string' || !SERVICE_RE.test(s)) throw new HttpError(400, 'Invalid service name');
  return [...new Set(all)];
}

route('POST', '/api/projects/:id/actions/:action', async (req, res, { params }) => {
  const p = await projects.get(params.id);
  const opts = await readBody(req);
  const services = serviceList(opts);
  const recreate = ['force', 'no'].includes(opts.recreate) ? opts.recreate : undefined;
  if (params.action !== 'start' && !actionSteps(params.action)) throw new HttpError(400, `Unknown action: ${params.action}`);
  if (busy.has(p.id)) throw new HttpError(409, `"${busy.get(p.id)}" is already running for this project`);

  busy.set(p.id, params.action);
  try {
    const tails = params.action === 'start'
      ? await startSteps(p, services)
      : actionSteps(params.action, { services, pull: !!opts.pull, noCache: !!opts.noCache, recreate });
    if (!tails.length) throw new HttpError(422, 'This project has no services to start');
    const base = projectArgs(p);
    await streamSteps(res, tails.map((t) => [...base, ...t]), p.directory);
  } finally {
    busy.delete(p.id);
  }
});

route('GET', '/api/system/df', async (req, res) => send(res, 200, { rows: await diskUsage(), pruning }));

route('POST', '/api/system/prune', async (req, res) => {
  const body = await readBody(req);
  const until = body.until ?? '';
  if (!PRUNE_UNTIL.includes(until)) throw new HttpError(400, 'Invalid "until" filter');
  if (until && (body.target === 'volumes' || (body.target === 'system' && body.volumes))) {
    throw new HttpError(400, 'Docker cannot filter volumes by age');
  }
  const args = pruneArgs({ target: body.target, all: body.all === true, volumes: body.volumes === true, until });
  if (!args) throw new HttpError(400, 'Unknown prune target');
  if (pruning) throw new HttpError(409, 'A clean-up is already running');
  pruning = true;
  try {
    await streamSteps(res, [args]);
  } finally {
    pruning = false;
  }
});

route('GET', '/api/projects/:id/logs', async (req, res, { params, query }) => {
  const p = await projects.get(params.id);
  const service = query.get('service');
  if (service && !SERVICE_RE.test(service)) throw new HttpError(400, 'Invalid service name');
  const tail = query.get('tail') || '200';
  if (!/^(all|\d{1,6})$/.test(tail)) throw new HttpError(400, 'Invalid tail');
  const args = [...projectArgs(p), 'logs', '--no-color', '--tail', tail];
  if (query.get('follow') === '1') args.push('--follow');
  if (query.get('timestamps') === '1') args.push('--timestamps');
  if (service) args.push(service);
  const write = ndjson(res);
  const child = stream(args, {
    cwd: p.directory,
    onData: (d) => write({ t: 'out', d }),
    onExit: (code) => { write({ t: 'exit', code }); res.end(); },
  });
  res.on('close', () => child.kill('SIGTERM'));
});

route('GET', '/api/projects/:id/files', async (req, res, { params, query }) => {
  const p = await projects.get(params.id);
  const abs = projects.resolveProjectFile(p, query.get('path'));
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return send(res, 200, { path: query.get('path'), exists: false, content: '' });
  if (st.size > MAX_FILE) throw new HttpError(413, 'File too large to edit here');
  send(res, 200, { path: query.get('path'), exists: true, content: await fs.readFile(abs, 'utf8'), mtime: st.mtimeMs });
});

route('PUT', '/api/projects/:id/files', async (req, res, { params, query }) => {
  const p = await projects.get(params.id);
  const file = query.get('path');
  const abs = projects.resolveProjectFile(p, file);
  const { content, validate = true } = await readBody(req);
  if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
  if (Buffer.byteLength(content) > MAX_FILE) throw new HttpError(413, 'File too large');

  const previous = await fs.readFile(abs, 'utf8').catch(() => null);
  const isEnv = projects.ENV_FILE_RE.test(path.basename(abs));
  await fs.writeFile(abs, content, isEnv && previous === null ? { mode: 0o600 } : undefined);

  // Validate files the project actually uses; roll back if compose rejects the result.
  const used = [...p.composeFiles, ...p.envFiles].some((f) => path.resolve(p.directory, f) === abs);
  if (validate && used) {
    const r = await run([...projectArgs(p), 'config', '--quiet'], { cwd: p.directory });
    if (r.code !== 0) {
      if (previous === null) await fs.rm(abs, { force: true });
      else await fs.writeFile(abs, previous);
      throw new HttpError(422, `Not saved, docker compose config failed:\n${r.stderr.trim()}`);
    }
  }
  send(res, 200, { ok: true });
});

route('GET', '/api/projects/:id/validate', async (req, res, { params }) => {
  const p = await projects.get(params.id);
  const r = await run([...projectArgs(p), 'config', '--quiet'], { cwd: p.directory });
  send(res, 200, { ok: r.code === 0, error: r.stderr.trim() });
});

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
};

async function serveStatic(req, res, pathname) {
  let file = path.join(config.webDist, path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ''));
  if (!file.startsWith(config.webDist)) return send(res, 404, { error: 'Not found' });
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) file = path.join(config.webDist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('Frontend not built. Run: npm run build');
  }
  const immutable = pathname.startsWith('/assets/');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res, url.pathname);
    }
    // CSRF guard: browsers cannot send this header cross-site without a CORS preflight, which we never allow.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'docker-panel') {
      return send(res, 403, { error: 'Missing X-Requested-With header' });
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const user = auth.readSession(req);
      if (!r.open && !user) return send(res, 401, { error: 'Not signed in' });
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return await r.handler(req, res, { params, query: url.searchParams, user });
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (res.headersSent) {
      if (!res.writableEnded) res.end(JSON.stringify({ t: 'out', d: `\n${e.message}\n` }) + '\n');
      return;
    }
    send(res, status, { error: e.message || 'Server error' });
  }
});

server.requestTimeout = 0; // actions and log streams can run for a long time
server.listen(config.port, config.host, () => {
  console.log(`[docker-panel] listening on http://${config.host}:${config.port}`);
});
