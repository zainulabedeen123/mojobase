// Console accounts: scrypt password hashes and HMAC-signed session cookies.
import crypto from 'node:crypto';
import { config } from './config.js';
import { users } from './store.js';

const COOKIE = 'mb_session';
const SESSION_DAYS = 14;
const sigKey = crypto
  .createHash('sha256')
  .update(`mojobase-session:${config.consoleSecret}`)
  .digest();

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(password, stored) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: 16384,
    r: 8,
    p: 1,
  });
  return crypto.timingSafeEqual(expected, actual);
}

const sign = (payload) => crypto.createHmac('sha256', sigKey).update(payload).digest('base64url');
// Cookie: <userId>.<sessionVersion>.<expiry>.<hmac>. Bumping a user's
// session_version (password reset, account deletion) invalidates every cookie.
export function setSession(res, user) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${user.id}.${user.session_version ?? 1}.${exp}`;
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400_000,
  });
}
export function clearSession(res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}
function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}
export function currentUser(req) {
  const raw = readCookie(req);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const [id, version, exp, sig] = parts;
  const expected = sign(`${id}.${version}.${exp}`);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  )
    return null;
  if (Number(exp) < Date.now()) return null;
  const user = users.byId(id);
  if (!user || String(user.session_version) !== version) return null;
  return {
    id: user.id,
    email: user.email,
    emailVerified: !!user.email_verified,
    createdAt: user.created_at,
  };
}
export function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

// Cookie-authenticated writes must come from our own origin (CSRF protection on top of SameSite=Lax).
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== config.consoleOrigin)
    return res.status(403).json({ error: 'Cross-origin request refused' });
  if (!req.is('application/json') && req.method !== 'DELETE')
    return res.status(415).json({ error: 'JSON body required' });
  next();
}

// Tiny fixed-window rate limiter keyed by client IP.
export function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => hits.clear(), windowMs).unref();
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
      .split(',')[0]
      .trim();
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > max) return res.status(429).json({ error: 'Too many attempts, try again in a minute' });
    next();
  };
}
