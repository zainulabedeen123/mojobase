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
db.exec(`
  -- Personal access tokens for the MCP server and API. Only a hash is stored.
  CREATE TABLE IF NOT EXISTS access_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,              -- last 4 characters, to tell tokens apart
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
`);
db.exec(`
  -- Offsite backups. Destination config (keys, refresh tokens) is AES-256-GCM encrypted.
  CREATE TABLE IF NOT EXISTS offsite_settings (
    ref TEXT PRIMARY KEY REFERENCES projects(ref) ON DELETE CASCADE,
    hours TEXT NOT NULL,             -- JSON array of UTC hours
    retention_days INTEGER NOT NULL,
    include_files INTEGER NOT NULL,
    last_slot TEXT,                  -- YYYY-MM-DDTHH of the last scheduled run
    last_alert_at INTEGER,           -- ms epoch of the last failure email
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS offsite_destinations (
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
    type TEXT NOT NULL,              -- s3 | gdrive
    label TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL,            -- AES-256-GCM encrypted JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS offsite_runs (
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
    trigger TEXT NOT NULL,           -- scheduled | manual
    status TEXT NOT NULL,            -- running | ok | partial | failed
    folder TEXT,                     -- <project>-<ref>/<stamp>
    artifacts TEXT,                  -- JSON [{name, size, sha256}]
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX IF NOT EXISTS offsite_runs_ref ON offsite_runs (ref, started_at);
  CREATE TABLE IF NOT EXISTS offsite_run_targets (
    run_id TEXT NOT NULL REFERENCES offsite_runs(id) ON DELETE CASCADE,
    destination_id TEXT NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL,            -- running | ok | failed
    bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error TEXT,
    note TEXT,
    PRIMARY KEY (run_id, destination_id)
  );
  -- Pending Google OAuth connections: single-use state, only a hash is stored.
  CREATE TABLE IF NOT EXISTS oauth_states (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ref TEXT NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
    payload TEXT NOT NULL,           -- AES-256-GCM encrypted JSON
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
  rename: (ref, name) => db.prepare('UPDATE projects SET name = ? WHERE ref = ?').run(name, ref),
  countByStatus: (status) =>
    db.prepare('SELECT COUNT(*) AS n FROM projects WHERE status = ?').get(status).n,
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

export const accessTokens = {
  // Returns the raw token once; only its hash is kept.
  create(userId, name) {
    const raw = `mbp_${crypto.randomBytes(32).toString('base64url')}`;
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO access_tokens (id, user_id, name, hash, hint) VALUES (?, ?, ?, ?, ?)'
    ).run(id, userId, name, sha256(raw), raw.slice(-4));
    return { id, token: raw };
  },
  forUser: (userId) =>
    db
      .prepare(
        'SELECT id, name, hint, created_at, last_used_at FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId),
  countForUser: (userId) =>
    db.prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ?').get(userId).n,
  revoke: (userId, id) =>
    db.prepare('DELETE FROM access_tokens WHERE user_id = ? AND id = ?').run(userId, id).changes,
  // Resolves a raw token to its user (or null) and records when it was last used.
  authenticate(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('mbp_')) return null;
    const row = db.prepare('SELECT id, user_id FROM access_tokens WHERE hash = ?').get(sha256(raw));
    if (!row) return null;
    db.prepare("UPDATE access_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
    const user = users.byId(row.user_id);
    return user
      ? { id: user.id, email: user.email, emailVerified: !!user.email_verified, tokenId: row.id }
      : null;
  },
};

// ------------------------------------------------------------------ offsite backups
export const OFFSITE_DEFAULTS = { hours: [3, 15], retentionDays: 30, includeFiles: true };
const destRow = (r) => (r ? { ...r, enabled: !!r.enabled, config: decrypt(r.config) } : undefined);
const runRow = (r) =>
  r ? { ...r, artifacts: r.artifacts ? JSON.parse(r.artifacts) : [] } : undefined;

export const offsite = {
  settings(ref) {
    const r = db.prepare('SELECT * FROM offsite_settings WHERE ref = ?').get(ref);
    if (!r) return { ...OFFSITE_DEFAULTS, lastSlot: null, lastAlertAt: null };
    return {
      hours: JSON.parse(r.hours),
      retentionDays: r.retention_days,
      includeFiles: !!r.include_files,
      lastSlot: r.last_slot,
      lastAlertAt: r.last_alert_at,
    };
  },
  saveSettings(ref, { hours, retentionDays, includeFiles }) {
    db.prepare(
      `INSERT INTO offsite_settings (ref, hours, retention_days, include_files) VALUES (?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET hours = excluded.hours, retention_days = excluded.retention_days,
         include_files = excluded.include_files, updated_at = datetime('now')`
    ).run(ref, JSON.stringify(hours), retentionDays, includeFiles ? 1 : 0);
  },
  ensureSettings(ref) {
    const d = OFFSITE_DEFAULTS;
    db.prepare(
      'INSERT OR IGNORE INTO offsite_settings (ref, hours, retention_days, include_files) VALUES (?, ?, ?, ?)'
    ).run(ref, JSON.stringify(d.hours), d.retentionDays, d.includeFiles ? 1 : 0);
  },
  setLastSlot(ref, slot) {
    offsite.ensureSettings(ref);
    db.prepare('UPDATE offsite_settings SET last_slot = ? WHERE ref = ?').run(slot, ref);
  },
  setLastAlert(ref, at) {
    offsite.ensureSettings(ref);
    db.prepare('UPDATE offsite_settings SET last_alert_at = ? WHERE ref = ?').run(at, ref);
  },

  destinations: (ref) =>
    db
      .prepare('SELECT * FROM offsite_destinations WHERE ref = ? ORDER BY created_at, id')
      .all(ref)
      .map(destRow),
  destination: (ref, id) =>
    destRow(db.prepare('SELECT * FROM offsite_destinations WHERE ref = ? AND id = ?').get(ref, id)),
  countDestinations: (ref) =>
    db.prepare('SELECT COUNT(*) AS n FROM offsite_destinations WHERE ref = ?').get(ref).n,
  insertDestination({ id, ref, type, label, enabled, config: cfg }) {
    db.prepare(
      'INSERT INTO offsite_destinations (id, ref, type, label, enabled, config) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, ref, type, label, enabled ? 1 : 0, encrypt(cfg));
  },
  updateDestination(ref, id, { label, enabled, config: cfg }) {
    db.prepare(
      'UPDATE offsite_destinations SET label = ?, enabled = ?, config = ? WHERE ref = ? AND id = ?'
    ).run(label, enabled ? 1 : 0, encrypt(cfg), ref, id);
  },
  removeDestination: (ref, id) =>
    db.prepare('DELETE FROM offsite_destinations WHERE ref = ? AND id = ?').run(ref, id).changes,
  // Projects that have at least one enabled destination.
  scheduledRefs: () =>
    db
      .prepare('SELECT DISTINCT ref FROM offsite_destinations WHERE enabled = 1')
      .all()
      .map((r) => r.ref),

  insertRun({ id, ref, trigger, startedAt }) {
    db.prepare(
      "INSERT INTO offsite_runs (id, ref, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)"
    ).run(id, ref, trigger, startedAt);
  },
  updateRun(id, { status, folder, artifacts, error, finishedAt }) {
    db.prepare(
      `UPDATE offsite_runs SET status = COALESCE(?, status), folder = COALESCE(?, folder),
         artifacts = COALESCE(?, artifacts), error = ?, finished_at = ? WHERE id = ?`
    ).run(
      status ?? null,
      folder ?? null,
      artifacts ? JSON.stringify(artifacts) : null,
      error ?? null,
      finishedAt ?? null,
      id
    );
  },
  setTarget({
    runId,
    destinationId,
    type,
    label,
    status,
    bytes = 0,
    durationMs = null,
    error = null,
    note = null,
  }) {
    db.prepare(
      `INSERT INTO offsite_run_targets (run_id, destination_id, type, label, status, bytes, duration_ms, error, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, destination_id) DO UPDATE SET status = excluded.status, bytes = excluded.bytes,
         duration_ms = excluded.duration_ms, error = excluded.error, note = excluded.note`
    ).run(runId, destinationId, type, label, status, bytes, durationMs, error, note);
  },
  runs(ref, limit = 10) {
    const runs = db
      .prepare(
        'SELECT * FROM offsite_runs WHERE ref = ? ORDER BY started_at DESC, rowid DESC LIMIT ?'
      )
      .all(ref, limit)
      .map(runRow);
    const targets = db.prepare('SELECT * FROM offsite_run_targets WHERE run_id = ? ORDER BY rowid');
    return runs.map((r) => ({ ...r, targets: targets.all(r.id) }));
  },
  // Keeps the newest `keep` runs of a project.
  trimRuns(ref, keep = 200) {
    db.prepare(
      `DELETE FROM offsite_runs WHERE ref = ? AND id NOT IN
         (SELECT id FROM offsite_runs WHERE ref = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)`
    ).run(ref, ref, keep);
  },
  // After a console restart nothing is running any more.
  failInterrupted() {
    const msg = 'Interrupted by a console restart';
    db.prepare(
      "UPDATE offsite_run_targets SET status = 'failed', error = ? WHERE status = 'running'"
    ).run(msg);
    return db
      .prepare(
        "UPDATE offsite_runs SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'"
      )
      .run(msg, new Date().toISOString()).changes;
  },

  // Returns the raw state once; only its hash is stored (single use, 15 minutes).
  issueState(userId, ref, payload) {
    db.prepare('DELETE FROM oauth_states WHERE expires_at < ?').run(Date.now());
    const raw = crypto.randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO oauth_states (hash, user_id, ref, payload, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(sha256(raw), userId, ref, encrypt(payload), Date.now() + 15 * 60_000);
    return raw;
  },
  consumeState(raw) {
    const hash = sha256(String(raw || ''));
    const r = db.prepare('SELECT * FROM oauth_states WHERE hash = ?').get(hash);
    if (!r) return null;
    db.prepare('DELETE FROM oauth_states WHERE hash = ?').run(hash);
    if (r.expires_at < Date.now()) return null;
    return { userId: r.user_id, ref: r.ref, payload: decrypt(r.payload) };
  },
};
