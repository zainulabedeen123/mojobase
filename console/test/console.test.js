// Local tests: generated compose files are valid, and the HTTP API enforces
// auth, ownership, limits and CSRF. Provisioning itself needs a Docker host,
// so here it is expected to fail cleanly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbconsole-'));
const env = {
  ...process.env,
  CONSOLE_SECRET: 'x'.repeat(64),
  DATA_DIR: path.join(tmp, 'data'),
  PORT: '39123',
  INTERNAL_PORT: '39124',
  CONSOLE_ORIGIN: 'http://localhost:39123',
  CADDY_DATA_MOUNT: path.join(tmp, 'caddy'),
  PROJECT_APP_IMAGE: 'ghcr.io/example/mojobase:test',
  PROJECT_POSTGRES_IMAGE: 'ghcr.io/example/mojobase-postgres:test',
  PROJECT_DENO_IMAGE: 'ghcr.io/example/mojobase-deno:test',
  MAX_PROJECTS_PER_USER: '1',
  NODE_NO_WARNINGS: '1',
};
// Fake the Let's Encrypt certificate Caddy would hold for db.mojobase.dev
const certDir = path.join(
  tmp,
  'caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/db.mojobase.dev'
);
fs.mkdirSync(certDir, { recursive: true });
fs.writeFileSync(path.join(certDir, 'db.mojobase.dev.crt'), 'x');
fs.writeFileSync(path.join(certDir, 'db.mojobase.dev.key'), 'x');

let server;
const BASE = 'http://localhost:39123';
const jar = {};
async function call(who, method, p, body, extraHeaders = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar[who] ? { Cookie: jar[who] } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/api/me');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});
after(() => {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('generated project compose file is valid for docker compose', async () => {
  process.env.PROJECT_APP_IMAGE = env.PROJECT_APP_IMAGE;
  process.env.PROJECT_POSTGRES_IMAGE = env.PROJECT_POSTGRES_IMAGE;
  process.env.PROJECT_DENO_IMAGE = env.PROJECT_DENO_IMAGE;
  process.env.CONSOLE_SECRET = env.CONSOLE_SECRET;
  process.env.DATA_DIR = path.join(tmp, 'unit');
  const { composeFile, newRef, newSecrets, connectionString } =
    await import('../src/project-stack.js');
  const ref = newRef();
  assert.match(ref, /^[a-z][a-z0-9]{15}$/);
  const s = newSecrets();
  const file = path.join(tmp, 'compose.yaml');
  fs.writeFileSync(file, composeFile(ref, 15401, s));
  const out = JSON.parse(
    execFileSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
      encoding: 'utf8',
    })
  );
  assert.equal(out.name, `mb-${ref}`);
  assert.deepEqual(Object.keys(out.services).sort(), ['app', 'deno', 'postgres', 'postgrest']);
  assert.equal(out.services.postgres.ports[0].published, '15401');
  assert.equal(out.services.postgres.ports[0].host_ip, '0.0.0.0');
  assert.ok(out.services.postgres.command[0].includes('hostnossl all all 0.0.0.0/0 reject'));
  assert.equal(out.services.app.environment.ACCESS_ANON_KEY, s.anonKey);
  assert.equal(out.networks.edge.name, 'mojobase-edge');
  assert.equal(
    connectionString(ref, 15401, s),
    `postgresql://mojobase:${s.dbPassword}@db.mojobase.dev:15401/insforge?sslmode=require`
  );
});

test('sign-up validation, login, and session', async () => {
  assert.equal(
    (await call('a', 'POST', '/api/signup', { email: 'bad', password: 'longenough1' })).status,
    400
  );
  assert.equal(
    (await call('a', 'POST', '/api/signup', { email: 'a@example.com', password: 'short' })).status,
    400
  );
  assert.equal(
    (
      await call('a', 'POST', '/api/signup', {
        email: 'a@example.com',
        password: 'correct-horse-1',
      })
    ).status,
    201
  );
  assert.equal(
    (
      await call('x', 'POST', '/api/signup', {
        email: 'A@example.com',
        password: 'correct-horse-1',
      })
    ).status,
    409
  );
  assert.equal(
    (await call('x', 'POST', '/api/login', { email: 'a@example.com', password: 'wrong-password' }))
      .status,
    401
  );
  const me = await call('a', 'GET', '/api/me');
  assert.equal(me.body.user.email, 'a@example.com');
  assert.equal((await call('anon', 'GET', '/api/projects')).status, 401);
});

test('cross-origin writes are refused', async () => {
  const r = await call(
    'a',
    'POST',
    '/api/projects',
    { name: 'evil' },
    { Origin: 'https://evil.example.com' }
  );
  assert.equal(r.status, 403);
});

test('create project, ownership isolation, per-user limit, tls-ask, delete', async () => {
  const created = await call('a', 'POST', '/api/projects', { name: 'My App' });
  assert.equal(created.status, 202);
  const ref = created.body.project.ref;
  assert.equal(created.body.project.apiUrl, `https://${ref}.mojobase.dev`);
  assert.equal(
    created.body.project.anonKey,
    undefined,
    'secrets are not returned before the project is ready'
  );

  assert.equal(
    (await call('a', 'POST', '/api/projects', { name: 'Second' })).status,
    403,
    'per-user limit'
  );
  assert.equal(
    (await call('a', 'POST', '/api/projects', { name: '<script>' })).status,
    400,
    'name validation'
  );

  await call('b', 'POST', '/api/signup', { email: 'b@example.com', password: 'correct-horse-2' });
  assert.equal(
    (await call('b', 'GET', `/api/projects/${ref}`)).status,
    404,
    'other users cannot see it'
  );
  assert.equal(
    (await call('b', 'DELETE', `/api/projects/${ref}`)).status,
    404,
    'other users cannot delete it'
  );
  assert.deepEqual((await call('b', 'GET', '/api/projects')).body.projects, []);

  const ask = (d) => fetch(`http://localhost:39124/tls-ask?domain=${d}`).then((r) => r.status);
  assert.equal(await ask(`${ref}.mojobase.dev`), 200);
  assert.equal(await ask('aaaaaaaaaaaaaaaa.mojobase.dev'), 404);
  assert.equal(await ask(`x.${ref}.mojobase.dev`), 404);
  assert.equal(await ask('evil.com'), 404);

  // No Docker daemon here: provisioning must end as a clean failure, not hang.
  let status;
  for (let i = 0; i < 100; i++) {
    status = (await call('a', 'GET', `/api/projects/${ref}`)).body.project.status;
    if (status !== 'provisioning') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status, 'failed');

  assert.equal((await call('a', 'DELETE', `/api/projects/${ref}`)).status, 202);
  // With Docker the project disappears; without it, the stack can't be confirmed
  // gone, so the record must stay and say why rather than silently vanish.
  for (let i = 0; i < 100; i++) {
    const r = await call('a', 'GET', `/api/projects/${ref}`);
    if (r.status === 404) return;
    if (r.body.project.status === 'failed' && /Delete failed/.test(r.body.project.error)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('delete never reached a final state');
});
