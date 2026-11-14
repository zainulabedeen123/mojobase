// Creates and destroys project stacks through the host's Docker daemon.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { config, certDir } from './config.js';
import { projects } from './store.js';
import {
  composeFile,
  composeProject,
  connectionRoleSql,
  appContainer,
  postgresContainer,
  DB_NAME,
} from './project-stack.js';

const run = promisify(execFile);
// /docker/mb-<ref>/docker-compose.yml on the host: where hPanel's Docker Manager lists projects.
const projectDir = (ref) => path.join(config.composeRoot, composeProject(ref));
const composePath = (ref) => path.join(projectDir(ref), 'docker-compose.yml');
const backupsDir = (ref) => path.join(config.dataDir, 'backups', ref);
const log = (ref, msg, extra) => console.log(JSON.stringify({ level: 'info', ref, msg, ...extra }));

async function compose(ref, args, timeout = 15 * 60_000) {
  return run('docker', ['compose', '-f', composePath(ref), '-p', composeProject(ref), ...args], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function psqlDb(container, db, sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      db,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`psql exited ${code}: ${err.trim()}`))
    );
    p.stdin.end(sql);
  });
}

function psql(container, sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('docker', [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      DB_NAME,
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`psql exited ${code}: ${err.trim()}`))
    );
    p.stdin.end(sql);
  });
}

export function dbCertReady() {
  const dir = certDir();
  return (
    fs.existsSync(path.join(dir, `${config.dbHost}.crt`)) &&
    fs.existsSync(path.join(dir, `${config.dbHost}.key`))
  );
}

async function waitForApp(ref, timeoutMs = 6 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${appContainer(ref)}:7130/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.message;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Backend did not become healthy in time (${last})`);
}

// One provisioning job at a time keeps memory spikes (image pulls, migrations) bounded.
let queue = Promise.resolve();
const enqueue = (job) => (queue = queue.then(job, job));

export function provision(ref) {
  return enqueue(async () => {
    const p = projects.get(ref);
    if (!p || p.status === 'deleting') return;
    try {
      if (!dbCertReady()) throw new Error('Database TLS certificate is not available yet');
      fs.mkdirSync(path.dirname(composePath(ref)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(composePath(ref), composeFile(ref, p.db_port, p.secrets), { mode: 0o600 });
      log(ref, 'starting stack');
      await compose(ref, ['up', '-d', '--quiet-pull', '--remove-orphans']);
      await waitForApp(ref);
      await psql(postgresContainer(ref), connectionRoleSql(p.secrets));
      await configureProjectEmail(ref, p);
      projects.setStatus(ref, 'ready');
      log(ref, 'project ready');
    } catch (e) {
      const message = (e.stderr || e.message || String(e)).toString().slice(-600);
      projects.setStatus(ref, 'failed', message);
      log(ref, 'provisioning failed', { error: message });
    }
  });
}

export function destroy(ref) {
  return enqueue(async () => {
    try {
      if (fs.existsSync(composePath(ref)))
        await compose(ref, ['down', '--volumes', '--remove-orphans'], 5 * 60_000);
      fs.rmSync(projectDir(ref), { recursive: true, force: true });
      fs.rmSync(backupsDir(ref), { recursive: true, force: true });
      projects.remove(ref);
      log(ref, 'project deleted');
    } catch (e) {
      projects.setStatus(
        ref,
        'failed',
        `Delete failed: ${(e.stderr || e.message).toString().slice(-400)}`
      );
    }
  });
}

// Point the project's own auth emails (verification, password reset, magic
// links) at the platform's email provider. Users can change it later in the
// project dashboard. Skipped when no provider is configured.
async function configureProjectEmail(ref, p) {
  const smtp = config.projectSmtp;
  if (!smtp.password) return;
  const res = await fetch(`http://${appContainer(ref)}:7130/api/auth/smtp-config`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${p.secrets.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      host: smtp.host,
      port: smtp.port,
      username: smtp.username,
      password: smtp.password,
      senderEmail: smtp.senderEmail,
      senderName: p.name,
      minIntervalSeconds: 60,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok)
    throw new Error(`Email setup failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

// ------------------------------------------------------------------ backups
// pg_dump (custom format) of the whole project database, taken inside the
// project's Postgres container and streamed into the console's data volume.
const BACKUP_FILE = /^[a-z0-9]{16}-\d{8}T\d{6}Z\.dump$/;
let backupChain = Promise.resolve();

// Backup metadata (name, manual/scheduled) lives in a JSON file next to each dump.
const metaPath = (ref, file) => path.join(backupsDir(ref), `${file}.json`);
function readMeta(ref, file) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(ref, file), 'utf8'));
  } catch {
    return {};
  }
}
// Matches what the project dashboard tells users ("up to 5 backups manually").
export const MAX_MANUAL_BACKUPS = 5;

export function backupProject(
  ref,
  { name = null, trigger = 'manual', createdBy = null, safety = false } = {}
) {
  const job = async () => {
    const p = projects.get(ref);
    if (!p || p.status !== 'ready') throw new Error('Project is not ready');
    // People choose which manual backups to keep; only the automatic safety
    // backup taken before a restore may push out the oldest one.
    if (
      trigger === 'manual' &&
      !safety &&
      listBackups(ref).filter((b) => b.trigger !== 'scheduled').length >= MAX_MANUAL_BACKUPS
    )
      throw new Error(
        `You can keep up to ${MAX_MANUAL_BACKUPS} manual backups. Delete one to make room.`
      );
    fs.mkdirSync(backupsDir(ref), { recursive: true, mode: 0o700 });
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    const file = path.join(backupsDir(ref), `${ref}-${stamp}.dump`);
    const tmp = `${file}.partial`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      const dump = spawn('docker', [
        'exec',
        postgresContainer(ref),
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        DB_NAME,
        '-Fc',
        '-Z',
        '6',
      ]);
      let err = '';
      dump.stdout.pipe(out);
      dump.stderr.on('data', (d) => (err += d));
      dump.on('error', reject);
      dump.on('close', (code) =>
        out.end(() =>
          code === 0
            ? resolve()
            : reject(new Error(`pg_dump exited ${code}: ${err.trim().slice(0, 300)}`))
        )
      );
    });
    fs.renameSync(tmp, file);
    fs.writeFileSync(
      metaPath(ref, path.basename(file)),
      JSON.stringify({ name, trigger, createdBy }),
      { mode: 0o600 }
    );
    // Keep the newest N scheduled and MAX_MANUAL_BACKUPS manual backups.
    const all = listBackups(ref);
    const prune = [
      ...all.filter((b) => b.trigger === 'scheduled').slice(config.backupKeep),
      ...all.filter((b) => b.trigger !== 'scheduled').slice(MAX_MANUAL_BACKUPS),
    ];
    for (const old of prune) deleteBackup(ref, old.file);
    log(ref, 'backup created', { file: path.basename(file) });
    return path.basename(file);
  };
  const run = backupChain.then(job, job);
  backupChain = run.catch(() => {});
  return run;
}

export function listBackups(ref) {
  if (!fs.existsSync(backupsDir(ref))) return [];
  return fs
    .readdirSync(backupsDir(ref))
    .filter((f) => BACKUP_FILE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(backupsDir(ref), f));
      const meta = readMeta(ref, f);
      return {
        file: f,
        size: st.size,
        createdAt: st.mtime.toISOString(),
        name: meta.name ?? null,
        trigger: meta.trigger === 'scheduled' ? 'scheduled' : 'manual',
        createdBy: meta.createdBy ?? null,
      };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
}

// Absolute path of a backup file, or null if the name is not one of this project's backups.
export function backupPath(ref, file) {
  if (!BACKUP_FILE.test(file) || !file.startsWith(`${ref}-`)) return null;
  const full = path.join(backupsDir(ref), file);
  return fs.existsSync(full) ? full : null;
}

export function deleteBackup(ref, file) {
  const full = backupPath(ref, file);
  if (!full) return false;
  fs.rmSync(full, { force: true });
  fs.rmSync(metaPath(ref, file), { force: true });
  return true;
}

export function renameBackup(ref, file, name) {
  if (!backupPath(ref, file)) return false;
  fs.writeFileSync(metaPath(ref, file), JSON.stringify({ ...readMeta(ref, file), name }), {
    mode: 0o600,
  });
  return true;
}

// Replace the project database with a backup. A safety backup of the current
// state is taken first. The database is recreated from the dump (pg_restore
// --create), then the stack restarts so every service reconnects.
export function restoreBackup(ref, file) {
  const job = async () => {
    const full = backupPath(ref, file);
    if (!full) throw new Error('Backup not found');
    const p = projects.get(ref);
    if (!p || p.status !== 'ready') throw new Error('Project is not ready');
    await backupProject(ref, { name: `Before restoring ${file}`, trigger: 'manual', safety: true });
    projects.setStatus(ref, 'restoring');
    try {
      await compose(ref, ['stop', 'app', 'postgrest', 'deno']);
      await psqlDb(postgresContainer(ref), 'postgres', `DROP DATABASE ${DB_NAME} WITH (FORCE);`);
      await new Promise((resolve, reject) => {
        const restore = spawn('docker', [
          'exec',
          '-i',
          postgresContainer(ref),
          'pg_restore',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '--create',
          '--exit-on-error',
        ]);
        let err = '';
        restore.stderr.on('data', (d) => (err += d));
        restore.on('error', reject);
        restore.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`pg_restore exited ${code}: ${err.trim().slice(-400)}`))
        );
        fs.createReadStream(full).pipe(restore.stdin);
      });
      // Restart Postgres (pg_cron reattaches to the new database), then the rest.
      await compose(ref, ['restart', 'postgres']);
      await compose(ref, ['up', '-d']);
      await waitForApp(ref);
      projects.setStatus(ref, 'ready');
      log(ref, 'backup restored', { file });
    } catch (e) {
      projects.setStatus(ref, 'ready');
      // Bring services back even if the restore failed half-way.
      await compose(ref, ['up', '-d']).catch(() => {});
      throw e;
    }
  };
  return enqueue(job);
}

// ------------------------------------------------------------------ pause / resume
export function pauseProject(ref) {
  return enqueue(async () => {
    await compose(ref, ['stop']);
    projects.setStatus(ref, 'paused');
    log(ref, 'project paused');
  });
}

export function resumeProject(ref) {
  return enqueue(async () => {
    projects.setStatus(ref, 'resuming');
    try {
      await compose(ref, ['up', '-d']);
      await waitForApp(ref);
      projects.setStatus(ref, 'ready');
      log(ref, 'project resumed');
    } catch (e) {
      projects.setStatus(ref, 'paused', `Resume failed: ${e.message}`.slice(0, 600));
      throw e;
    }
  });
}

// Bring existing projects up to date with the current stack definition (new
// image versions, new settings). Only touches projects whose file changed.
export function reconcileProjects() {
  for (const p of projects.all()) {
    if (!['ready', 'paused'].includes(p.status)) continue;
    enqueue(async () => {
      const current = projects.get(p.ref);
      if (!current || !['ready', 'paused'].includes(current.status)) return;
      const next = composeFile(p.ref, current.db_port, current.secrets);
      const prev = fs.existsSync(composePath(p.ref))
        ? fs.readFileSync(composePath(p.ref), 'utf8')
        : '';
      if (prev === next) return;
      fs.mkdirSync(path.dirname(composePath(p.ref)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(composePath(p.ref), next, { mode: 0o600 });
      if (current.status === 'ready') {
        log(p.ref, 'updating project stack');
        await compose(p.ref, ['up', '-d', '--quiet-pull', '--remove-orphans']);
        await waitForApp(p.ref).catch((e) =>
          log(p.ref, 'update: app not healthy yet', { error: e.message })
        );
      }
    }).catch((e) => log(p.ref, 'update failed', { error: e.message }));
  }
}

// Nightly: back up every ready project once a day at BACKUP_HOUR_UTC.
let lastBackupDay = '';
export function scheduleBackups() {
  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== config.backupHourUtc || lastBackupDay === day) return;
    lastBackupDay = day;
    for (const p of projects.all().filter((x) => x.status === 'ready')) {
      await backupProject(p.ref, { trigger: 'scheduled' }).catch((e) =>
        log(p.ref, 'nightly backup failed', { error: e.message })
      );
    }
  };
  setInterval(tick, 5 * 60_000).unref();
}

// Caddy renews the db.<domain> certificate; copy the fresh one into every
// project's Postgres and reload its config. Runs on start and every 12 hours.
export async function refreshDbCerts() {
  if (!dbCertReady()) return;
  const cert = `/caddy-data/caddy/certificates/${config.acmeDirName}/${config.dbHost}/${config.dbHost}`;
  for (const p of projects.all().filter((x) => x.status === 'ready')) {
    try {
      await run('docker', [
        'exec',
        postgresContainer(p.ref),
        'sh',
        '-c',
        `cp ${cert}.crt /etc/mojobase/server.crt && cp ${cert}.key /etc/mojobase/server.key && chown postgres:postgres /etc/mojobase/server.* && chmod 600 /etc/mojobase/server.key`,
      ]);
      await psql(postgresContainer(p.ref), 'SELECT pg_reload_conf();');
    } catch (e) {
      log(p.ref, 'certificate refresh failed', { error: e.message });
    }
  }
}

// After a console restart, resume anything that was mid-flight.
export function resumePending() {
  for (const p of projects.all()) {
    if (p.status === 'provisioning') provision(p.ref);
    if (p.status === 'deleting') destroy(p.ref);
  }
}
