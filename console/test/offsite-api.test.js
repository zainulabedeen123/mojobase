// Offsite backup settings over the HTTP API: owner only, validated, secrets
// never returned, SSRF-guarded endpoints, and the Google Drive OAuth flow
// (signed, single-use state bound to the user) against a fake Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeGoogle } from './helpers/fake-google.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mboffapi-'));
const PORT = 39223;
const BASE = `http://localhost:${PORT}`;
const g = await fakeGoogle();
const env = {
  ...process.env,
  CONSOLE_SECRET: 'z'.repeat(64),
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
  ALLOW_PRIVATE_S3_ENDPOINTS: '',
  NODE_NO_WARNINGS: '1',
  ...g.env,
};
const certDir = path.join(
  tmp,
  'caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/db.mojobase.dev'
);
fs.mkdirSync(certDir, { recursive: true });
fs.writeFileSync(path.join(certDir, 'db.mojobase.dev.crt'), 'x');
fs.writeFileSync(path.join(certDir, 'db.mojobase.dev.key'), 'x');

let server;
let serverLog = '';
const jar = {};
async function call(who, method, p, body, { redirect = 'follow' } = {}) {
  const r = await fetch(BASE + p, {
    method,
    redirect,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar[who] ? { Cookie: jar[who] } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) jar[who] = set.split(';')[0];
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: json, text, location: r.headers.get('location') };
}

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});
after(async () => {
  server.kill();
  await g.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SECRET = 'S3-SECRET-wJalrXUtnFEMIK7MDENG';
const KEY_ID = 'AKIAEXAMPLEKEYID1234';
let ref;

test('setup: two accounts, one project', async () => {
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
      await call('b', 'POST', '/api/signup', {
        email: 'b@example.com',
        password: 'correct-horse-2',
      })
    ).status,
    201
  );
  const created = await call('a', 'POST', '/api/projects', { name: 'Shop' });
  assert.equal(created.status, 202);
  ref = created.body.project.ref;
});

test('only the owner can see or change offsite settings', async () => {
  assert.equal((await call('anon', 'GET', `/api/projects/${ref}/offsite`)).status, 401);
  assert.equal((await call('b', 'GET', `/api/projects/${ref}/offsite`)).status, 404);
  assert.equal(
    (
      await call('b', 'PUT', `/api/projects/${ref}/offsite/settings`, {
        hours: [1],
        retentionDays: 3,
        includeFiles: false,
      })
    ).status,
    404
  );
  assert.equal(
    (
      await call('b', 'POST', `/api/projects/${ref}/offsite/destinations`, {
        type: 's3',
        label: 'x',
        config: {},
      })
    ).status,
    404
  );
  assert.equal(
    (await call('b', 'POST', `/api/projects/${ref}/offsite/gdrive/connect`, {})).status,
    404
  );
  assert.equal((await call('b', 'POST', `/api/projects/${ref}/offsite/run`, {})).status, 404);
  const own = await call('a', 'GET', `/api/projects/${ref}/offsite`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.settings, { hours: [3, 15], retentionDays: 30, includeFiles: true });
  assert.equal(own.body.googleDrive.configured, true);
});

test('settings are validated', async () => {
  const put = (body) => call('a', 'PUT', `/api/projects/${ref}/offsite/settings`, body);
  assert.equal((await put({ hours: [25], retentionDays: 30, includeFiles: true })).status, 400);
  assert.equal((await put({ hours: [3], retentionDays: '30', includeFiles: true })).status, 400);
  assert.equal(
    (await put({ hours: [3], retentionDays: 30, includeFiles: true, evil: 1 })).status,
    400
  );
  const ok = await put({ hours: [2, 14, 20], retentionDays: 14, includeFiles: false });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.settings, {
    hours: [2, 14, 20],
    retentionDays: 14,
    includeFiles: false,
  });
});

test('S3 endpoints are SSRF-guarded', async () => {
  const add = (endpoint) =>
    call('a', 'POST', `/api/projects/${ref}/offsite/destinations`, {
      type: 's3',
      label: 'Bad',
      config: {
        endpoint,
        region: 'us-east-1',
        bucket: 'my-bucket',
        accessKeyId: KEY_ID,
        secretAccessKey: SECRET,
      },
    });
  for (const e of [
    'http://s3.amazonaws.com',
    'https://127.0.0.1:9000',
    'https://169.254.169.254',
    'https://10.0.0.5',
    'https://[::1]',
    'https://localhost',
    'https://mb-abc-app',
  ]) {
    const r = await add(e);
    assert.equal(r.status, 400, e);
    assert.match(r.body.error, /https|public/, e);
  }
});

test('secrets are never returned once saved', async () => {
  const created = await call('a', 'POST', `/api/projects/${ref}/offsite/destinations`, {
    type: 's3',
    label: 'AWS',
    enabled: true,
    config: {
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      region: 'eu-west-1',
      bucket: 'my-backups',
      prefix: 'prod',
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      pathStyle: false,
    },
  });
  assert.equal(created.status, 201);
  assert.ok(!created.text.includes(SECRET) && !created.text.includes(KEY_ID));
  assert.equal(created.body.destination.config.accessKeyId, '••••1234');
  assert.equal(created.body.destination.config.hasSecret, true);
  const id = created.body.destination.id;
  const patched = await call('a', 'PATCH', `/api/projects/${ref}/offsite/destinations/${id}`, {
    label: 'AWS eu',
    config: { bucket: 'my-backups-2' },
  });
  assert.equal(patched.status, 200);
  assert.ok(!patched.text.includes(SECRET));
  assert.equal(patched.body.destination.config.bucket, 'my-backups-2');
  const view = await call('a', 'GET', `/api/projects/${ref}/offsite`);
  assert.ok(!view.text.includes(SECRET) && !view.text.includes(KEY_ID));
  assert.equal(
    (
      await call('b', 'PATCH', `/api/projects/${ref}/offsite/destinations/${id}`, {
        enabled: false,
      })
    ).status,
    404
  );
  assert.equal(
    (await call('b', 'DELETE', `/api/projects/${ref}/offsite/destinations/${id}`)).status,
    404
  );
  // Encrypted at rest.
  const db = new DatabaseSync(path.join(env.DATA_DIR, 'console.db'), { readOnly: true });
  const raw = JSON.stringify(db.prepare('SELECT * FROM offsite_destinations').all());
  db.close();
  assert.ok(!raw.includes(SECRET) && !raw.includes(KEY_ID) && !raw.includes('my-backups'));
  assert.ok(!serverLog.includes(SECRET), 'never logged');
  // Back up now needs a ready project (no Docker here).
  assert.equal((await call('a', 'POST', `/api/projects/${ref}/offsite/run`, {})).status, 409);
  assert.equal(
    (await call('a', 'DELETE', `/api/projects/${ref}/offsite/destinations/${id}`)).status,
    200
  );
});

async function startConnect(who = 'a') {
  const r = await call(who, 'POST', `/api/projects/${ref}/offsite/gdrive/connect`, {
    label: 'My Drive',
    folderName: 'Shop backups',
  });
  assert.equal(r.status, 200);
  const u = new URL(r.body.url);
  assert.equal(u.origin + u.pathname, `${g.base}/auth`);
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('redirect_uri'), `${BASE}/api/backups/gdrive/callback`);
  return u.searchParams.get('state');
}
const callback = (who, params) =>
  call(who, 'GET', `/api/backups/gdrive/callback?${new URLSearchParams(params)}`, null, {
    redirect: 'manual',
  });
const messageOf = (r) => new URL(r.location, BASE).searchParams.get('message');

test('Google Drive: signed, single-use state bound to the user who started it', async () => {
  const state = await startConnect();
  const tampered = await callback('a', { state: `${state.slice(0, -2)}xx`, code: 'good-code' });
  assert.equal(tampered.status, 302);
  assert.match(messageOf(tampered), /Invalid sign-in state/);
  const forged = await callback('a', { state: 'abc.def', code: 'good-code' });
  assert.match(messageOf(forged), /Invalid sign-in state/);
  const other = await callback('b', { state, code: 'good-code' });
  assert.match(messageOf(other), /another account/);
  const replay = await callback('a', { state, code: 'good-code' });
  assert.match(messageOf(replay), /expired or was already used/, 'a used state cannot be reused');
  const anon = await callback('anon', { state: await startConnect(), code: 'good-code' });
  assert.match(messageOf(anon), /Sign in/);
});

test('Google Drive: consent denied, then connected', async () => {
  const denied = await callback('a', { state: await startConnect(), error: 'access_denied' });
  assert.equal(denied.location.split('?')[0], `/projects/${ref}`);
  assert.match(messageOf(denied), /not granted/);

  const ok = await callback('a', { state: await startConnect(), code: 'good-code' });
  assert.equal(ok.location, `/projects/${ref}?offsite=connected`);
  const view = await call('a', 'GET', `/api/projects/${ref}/offsite`);
  const d = view.body.destinations.find((x) => x.type === 'gdrive');
  assert.deepEqual(d.config, {
    folderName: 'Shop backups',
    account: 'owner@gmail.example',
    connected: true,
  });
  assert.equal(d.label, 'My Drive');
  assert.ok(!view.text.includes('refresh-1'), 'refresh token never returned');
  assert.ok(g.paths().includes('Shop backups'), 'backup folder created in Drive');
  const db = new DatabaseSync(path.join(env.DATA_DIR, 'console.db'), { readOnly: true });
  const raw = JSON.stringify(db.prepare('SELECT * FROM offsite_destinations').all());
  db.close();
  assert.ok(!raw.includes('refresh-1'));
  // Test connection through the API (writes and deletes a small file).
  const t = await call('a', 'POST', `/api/projects/${ref}/offsite/destinations/${d.id}/test`, {});
  assert.deepEqual(Object.keys(t.body).sort(), ['durationMs', 'ok']);
  assert.equal(t.body.ok, true);
});
