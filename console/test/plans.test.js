// Plans: Free accounts are limited, Pro and admin accounts are not; only a
// confirmed ADMIN_EMAILS account can see accounts or change plans.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mbplans-'));
const PORT = 39243;
const BASE = `http://localhost:${PORT}`;
const env = {
  ...process.env,
  CONSOLE_SECRET: 'p'.repeat(64),
  DATA_DIR: path.join(tmp, 'data'),
  PORT: String(PORT),
  INTERNAL_PORT: String(PORT + 1),
  CONSOLE_ORIGIN: BASE,
  CADDY_DATA_MOUNT: path.join(tmp, 'caddy'),
  PROJECT_APP_IMAGE: 'ghcr.io/example/mojobase:test',
  PROJECT_POSTGRES_IMAGE: 'ghcr.io/example/mojobase-postgres:test',
  PROJECT_DENO_IMAGE: 'ghcr.io/example/mojobase-deno:test',
  REQUIRE_VERIFIED_EMAIL: 'false',
  AUTH_RATE_LIMIT: '1000',
  COMPOSE_ROOT: path.join(tmp, 'docker'),
  RESEND_API_KEY: '',
  MAX_PROJECTS_PER_USER: '1',
  MAX_PROJECTS: '2',
  ADMIN_EMAILS: ' Boss@Example.com ',
  NODE_NO_WARNINGS: '1',
};
const certDir = path.join(
  tmp,
  'caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/db.mojobase.dev'
);
fs.mkdirSync(certDir, { recursive: true });
fs.writeFileSync(path.join(certDir, 'db.mojobase.dev.crt'), 'x');
fs.writeFileSync(path.join(certDir, 'db.mojobase.dev.key'), 'x');

let server;
const jar = {};
async function call(who, method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json', Origin: BASE } : {}),
      ...(jar[who] ? { Cookie: jar[who] } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
const signup = (who, email) =>
  call(who, 'POST', '/api/signup', { email, password: 'correct horse battery' });
const create = (who, name) => call(who, 'POST', '/api/projects', { name });
const confirm = (email) => {
  const db = new DatabaseSync(path.join(tmp, 'data', 'console.db'));
  db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
  db.close();
};

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(BASE + '/api/me').then(
        (r) => r.ok,
        () => false
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => {
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('Free accounts hit the project limit and are pointed at Pro', async () => {
  await signup('free', 'free@example.com');
  const me = await call('free', 'GET', '/api/me');
  assert.equal(me.json.user.planLabel, 'Free');
  assert.equal(me.json.limits.perUser, 1);
  assert.equal((await create('free', 'one')).status, 202);
  const second = await create('free', 'two');
  assert.equal(second.status, 403);
  assert.match(second.json.error, /Free plan includes 1 project.*Pro/);
});

test('an admin email is only an admin once the email is confirmed', async () => {
  await signup('boss', 'boss@example.com');
  let me = await call('boss', 'GET', '/api/me');
  assert.equal(me.json.user.isAdmin, false, 'unconfirmed email is not trusted');
  assert.equal((await call('boss', 'GET', '/api/admin/users')).status, 404);
  confirm('boss@example.com');
  me = await call('boss', 'GET', '/api/me');
  assert.equal(me.json.user.isAdmin, true);
  assert.equal(me.json.user.planLabel, 'Admin');
  assert.equal(me.json.limits.perUser, null);
});

test('the admin can create projects past the per-account and capacity limits', async () => {
  // Limits here: 1 project per Free account, 2 on the whole server (one is already used).
  for (const name of ['a', 'b']) assert.equal((await create('boss', name)).status, 202, name);
  // Capacity is now exceeded: it still stops everyone else.
  await signup('late', 'late@example.com');
  assert.equal((await create('late', 'x')).status, 503);
});

test('only the admin can list accounts and grant or remove Pro', async () => {
  assert.equal((await call('free', 'GET', '/api/admin/users')).status, 404);
  assert.equal((await call(null, 'GET', '/api/admin/users')).status, 401);
  const list = await call('boss', 'GET', '/api/admin/users');
  const free = list.json.users.find((u) => u.email === 'free@example.com');
  assert.deepEqual([free.plan, free.projects, free.isAdmin], ['free', 1, false]);
  assert.equal(list.json.users.find((u) => u.email === 'boss@example.com').isAdmin, true);
  for (const u of list.json.users) assert.equal(u.password_hash, undefined);

  const path_ = `/api/admin/users/${free.id}/plan`;
  assert.equal((await call('free', 'POST', path_, { plan: 'pro' })).status, 404, 'no self-upgrade');
  assert.equal((await call('boss', 'POST', path_, { plan: 'gold' })).status, 400);
  assert.equal((await call('boss', 'POST', path_, { plan: 'pro' })).status, 200);

  const me = await call('free', 'GET', '/api/me');
  assert.equal(me.json.user.planLabel, 'Pro');
  assert.equal(me.json.limits.perUser, null);
  // (Project creation is rate limited, so the lifted limit is checked through /api/me.)

  assert.equal((await call('boss', 'POST', path_, { plan: 'free' })).status, 200);
  assert.equal((await call('free', 'GET', '/api/me')).json.limits.perUser, 1);
});
