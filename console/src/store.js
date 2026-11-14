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
`);

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
  byId: (id) => db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id),
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
