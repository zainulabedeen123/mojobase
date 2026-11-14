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
const projectsDir = path.join(config.dataDir, 'projects');
const composePath = (ref) => path.join(projectsDir, ref, 'compose.yaml');
const log = (ref, msg, extra) => console.log(JSON.stringify({ level: 'info', ref, msg, ...extra }));

async function compose(ref, args, timeout = 15 * 60_000) {
  return run('docker', ['compose', '-f', composePath(ref), '-p', composeProject(ref), ...args], {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
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
      fs.rmSync(path.join(projectsDir, ref), { recursive: true, force: true });
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
