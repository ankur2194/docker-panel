import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'dp_session';
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// Hash format: scrypt:N:r:p:salt:hash (base64url). No "$" so it is safe in .env and shell files.
export async function hashPassword(password) {
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N, r, p });
  return ['scrypt', N, r, p, b64u(salt), b64u(hash)].join(':');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 256 * Number(N) * Number(r),
  });
  return crypto.timingSafeEqual(actual, expected);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function checkCredentials(email, password) {
  if (!config.adminEmail || typeof email !== 'string' || typeof password !== 'string') return false;
  const emailOk = safeEqual(email.trim().toLowerCase(), config.adminEmail);
  let passOk = false;
  if (config.adminPasswordHash) passOk = await verifyPassword(password, config.adminPasswordHash);
  else if (config.adminPassword) passOk = safeEqual(password, config.adminPassword);
  return emailOk && passOk;
}

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

export function createSession(email) {
  const payload = b64u(JSON.stringify({ e: email, x: Date.now() + config.sessionTtlMs }));
  return `${payload}.${sign(payload)}`;
}

export function readSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof data.x !== 'number' || data.x < Date.now()) return null;
    return { email: data.e };
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isSecure(req) {
  if (config.cookieSecure === 'true') return true;
  if (config.cookieSecure === 'false') return false;
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

export function sessionCookie(req, token) {
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`];
  if (isSecure(req)) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// Simple in-memory throttle: 10 failed logins per IP per 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;

export function loginBlocked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) {
    failures.delete(ip);
    return false;
  }
  return f.count >= 10;
}

const MAX_TRACKED = 10_000;

export function recordFailure(ip) {
  // Forget expired entries here, so IPs that fail once and never return don't accumulate.
  const now = Date.now();
  for (const [k, v] of failures) if (now - v.first > WINDOW) failures.delete(k);
  if (failures.size >= MAX_TRACKED && !failures.has(ip)) failures.delete(failures.keys().next().value); // oldest first
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

export function clearFailures(ip) {
  failures.delete(ip);
}
