import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load ./.env if present (Node >= 20.12). Real environment variables win.
const envPath = process.env.DP_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envPath);
}

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const warnings = [];

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  warnings.push('SESSION_SECRET not set: using a random one, sessions end on restart.');
}

export const config = {
  root: ROOT,
  port: Number(env.PORT || 8080),
  host: env.HOST || '0.0.0.0',
  adminEmail: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  sessionSecret,
  sessionTtlMs: Number(env.SESSION_TTL_HOURS || 12) * 3600 * 1000,
  cookieSecure: env.COOKIE_SECURE || 'auto',
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  scanRoots: list(env.SCAN_ROOTS).map((p) => path.resolve(p)),
  defaultProjectsDir: path.resolve(env.DEFAULT_PROJECTS_DIR || list(env.SCAN_ROOTS)[0] || '/opt/stacks'),
  dockerBin: env.DOCKER_BIN || 'docker',
  webDist: path.join(ROOT, 'web', 'dist'),
};

if (!config.adminEmail || (!config.adminPasswordHash && !config.adminPassword)) {
  warnings.push('Set ADMIN_EMAIL and ADMIN_PASSWORD_HASH (see README). Login is disabled until then.');
}
if (config.adminPassword && !config.adminPasswordHash) {
  warnings.push('ADMIN_PASSWORD is plain text. Prefer ADMIN_PASSWORD_HASH (npm run hash-password).');
}
