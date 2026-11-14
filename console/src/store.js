// Persistence (node:sqlite) plus encryption of project secrets at rest.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'console.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS projects (
    ref TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    status TEXT NOT NULL,            -- provisioning | ready | failed | deleting
    db_port INTEGER NOT NULL UNIQUE,
    secrets TEXT NOT NULL,           -- AES-256-GCM encrypted JSON
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- One-time email links (verification, password reset). Only a hash is stored.
  CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- verify | reset
    expires_at INTEGER NOT NULL
  );
`);
// Additive migrations for databases created by earlier versions.
const userColumns = new Set(
  db
    .prepare('PRAGMA table_info(users)')
    .all()
    .map((c) => c.name)
);
if (!userColumns.has('email_verified'))
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
// Bumped on password reset / account deletion so existing session cookies stop working.
if (!userColumns.has('session_version'))
  db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1');

const key = crypto.createHash('sha256').update(`mojobase-secrets:${config.consoleSecret}`).digest();
export function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
export function decrypt(text) {
  const [iv, tag, data] = text.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
}

export const users = {
  create(id, email, passwordHash) {
    db.prepare('INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)').run(
      id,
      email,
      passwordHash
    );
  },
  byEmail: (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email),
  byId: (id) =>
    db
      .prepare(
        'SELECT id, email, created_at, email_verified, session_version FROM users WHERE id = ?'
      )
      .get(id),
  withHash: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  setVerified: (id) => db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(id),
  setPassword: (id, passwordHash) =>
    db
      .prepare(
        'UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?'
      )
      .run(passwordHash, id),
  remove: (id) => db.prepare('DELETE FROM users WHERE id = ?').run(id),
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const tokens = {
  // Returns the raw token (sent by email); only its hash is stored.
  issue(userId, kind, ttlMs) {
    db.prepare('DELETE FROM tokens WHERE user_id = ? AND kind = ?').run(userId, kind);
    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO tokens (hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)').run(
      sha256(raw),
      userId,
      kind,
      Date.now() + ttlMs
    );
    return raw;
  },
  // Single use: a token is deleted as soon as it is redeemed.
  consume(raw, kind) {
    const hash = sha256(String(raw || ''));
    const row = db.prepare('SELECT * FROM tokens WHERE hash = ? AND kind = ?').get(hash, kind);
    if (!row) return null;
    db.prepare('DELETE FROM tokens WHERE hash = ?').run(hash);
    return row.expires_at >= Date.now() ? row.user_id : null;
  },
  purgeExpired: () => db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(Date.now()),
};

const row = (r) => (r ? { ...r, secrets: decrypt(r.secrets) } : undefined);
export const projects = {
  insert(p) {
    db.prepare(
      'INSERT INTO projects (ref, owner_id, name, status, db_port, secrets) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(p.ref, p.ownerId, p.name, p.status, p.dbPort, encrypt(p.secrets));
  },
  setStatus(ref, status, error = null) {
    db.prepare('UPDATE projects SET status = ?, error = ? WHERE ref = ?').run(status, error, ref);
  },
  remove: (ref) => db.prepare('DELETE FROM projects WHERE ref = ?').run(ref),
  get: (ref) => row(db.prepare('SELECT * FROM projects WHERE ref = ?').get(ref)),
  forOwner: (ownerId) =>
    db
      .prepare(
        'SELECT ref, name, status, error, created_at FROM projects WHERE owner_id = ? ORDER BY created_at DESC'
      )
      .all(ownerId),
  all: () => db.prepare('SELECT * FROM projects').all().map(row),
  refsForOwner: (ownerId) =>
    db
      .prepare('SELECT ref FROM projects WHERE owner_id = ?')
      .all(ownerId)
      .map((r) => r.ref),
  count: () => db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
  countForOwner: (ownerId) =>
    db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_id = ?').get(ownerId).n,
  usedPorts: () =>
    new Set(
      db
        .prepare('SELECT db_port FROM projects')
        .all()
        .map((r) => r.db_port)
    ),
  exists: (ref) =>
    !!db.prepare("SELECT 1 FROM projects WHERE ref = ? AND status != 'deleting'").get(ref),
};
