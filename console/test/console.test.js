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
  REQUIRE_VERIFIED_EMAIL: 'true',
  AUTH_RATE_LIMIT: '1000',
  EMAIL_DEBUG_LOG: '1',
  COMPOSE_ROOT: path.join(tmp, 'docker'),
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
let serverLog = '';
// Email links the server would have sent (EMAIL_DEBUG_LOG=1 logs them).
const lastLink = (to, kind) => {
  const lines = serverLog.split('\n').filter((l) => l.includes('email not sent') && l.includes(to));
  const urls = lines.map((l) => JSON.parse(l).url).filter((u) => u && u.includes(kind));
  return new URL(urls.at(-1));
};
const settle = () => new Promise((r) => setTimeout(r, 300));
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
  server.stdout.on('data', (d) => (serverLog += d));
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

test('email verification is required before creating projects', async () => {
  const r = await call('a', 'POST', '/api/projects', { name: 'Too early' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Confirm your email/);
  await settle();
  const link = lastLink('a@example.com', '/verify');
  assert.equal(link.origin + link.pathname, 'http://localhost:39123/verify');
  assert.equal((await call('x', 'POST', '/api/verify', { token: 'nope' })).status, 400);
  assert.equal(
    (await call('x', 'POST', '/api/verify', { token: link.searchParams.get('token') })).status,
    200
  );
  assert.equal(
    (await call('x', 'POST', '/api/verify', { token: link.searchParams.get('token') })).status,
    400,
    'single use'
  );
  assert.equal((await call('a', 'GET', '/api/me')).body.user.emailVerified, true);
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
    (await call('b', 'GET', `/api/projects/${ref}/backups`)).status,
    404,
    'other users cannot list backups'
  );
  assert.deepEqual((await call('a', 'GET', `/api/projects/${ref}/backups`)).body.backups, []);
  assert.equal(
    (await call('a', 'GET', `/api/projects/${ref}/backups/../../console.db`)).status,
    404
  );
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

test('forgot / reset password signs out other sessions', async () => {
  await call('r1', 'POST', '/api/signup', {
    email: 'reset@example.com',
    password: 'original-pass-1',
  });
  await call('r2', 'POST', '/api/login', {
    email: 'reset@example.com',
    password: 'original-pass-1',
  });
  // Same answer whether or not the account exists
  assert.equal(
    (await call('anon', 'POST', '/api/forgot-password', { email: 'nobody@example.com' })).status,
    200
  );
  assert.equal(
    (await call('anon', 'POST', '/api/forgot-password', { email: 'reset@example.com' })).status,
    200
  );
  await settle();
  const token = lastLink('reset@example.com', '/reset-password').searchParams.get('token');
  assert.equal(
    (await call('anon', 'POST', '/api/reset-password', { token, password: 'short' })).status,
    400
  );
  assert.equal(
    (await call('new', 'POST', '/api/reset-password', { token, password: 'brand-new-pass-2' }))
      .status,
    200
  );
  assert.equal(
    (await call('new', 'POST', '/api/reset-password', { token, password: 'brand-new-pass-3' }))
      .status,
    400,
    'single use'
  );
  assert.equal((await call('r2', 'GET', '/api/me')).body.user, null, 'old session signed out');
  assert.equal((await call('new', 'GET', '/api/me')).body.user.email, 'reset@example.com');
  assert.equal(
    (await call('new', 'GET', '/api/me')).body.user.emailVerified,
    true,
    'reset proves email ownership'
  );
  assert.equal(
    (
      await call('x', 'POST', '/api/login', {
        email: 'reset@example.com',
        password: 'original-pass-1',
      })
    ).status,
    401
  );
  assert.equal(
    (
      await call('x', 'POST', '/api/login', {
        email: 'reset@example.com',
        password: 'brand-new-pass-2',
      })
    ).status,
    200
  );
});

test('account deletion needs the password and removes the account', async () => {
  await call('d', 'POST', '/api/signup', {
    email: 'delete-me@example.com',
    password: 'delete-me-pass-1',
  });
  assert.equal(
    (await call('d', 'POST', '/api/account/delete', { password: 'wrong-password' })).status,
    401
  );
  assert.equal(
    (await call('d', 'POST', '/api/account/delete', { password: 'delete-me-pass-1' })).status,
    200
  );
  assert.equal((await call('d', 'GET', '/api/me')).body.user, null);
  assert.equal(
    (
      await call('d2', 'POST', '/api/login', {
        email: 'delete-me@example.com',
        password: 'delete-me-pass-1',
      })
    ).status,
    401
  );
  // The address can be used again
  assert.equal(
    (
      await call('d3', 'POST', '/api/signup', {
        email: 'delete-me@example.com',
        password: 'delete-me-pass-2',
      })
    ).status,
    201
  );
});

test('MCP server: token auth, tools, ownership, revocation', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } =
    await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const connect = async (token) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      })
    );
    return client;
  };

  // No token / bad token
  await assert.rejects(connect(null));
  await assert.rejects(connect('mbp_not-a-real-token'));

  // Create a token in the console (cookie session), shown once
  await call('m', 'POST', '/api/signup', { email: 'mcp@example.com', password: 'mcp-user-pass-1' });
  const created = await call('m', 'POST', '/api/tokens', { name: 'Claude Code' });
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^mbp_[A-Za-z0-9_-]{43}$/);
  const listed = await call('m', 'GET', '/api/tokens');
  assert.equal(listed.body.tokens.length, 1);
  assert.equal(listed.body.tokens[0].token, undefined, 'raw token is never listed again');
  assert.equal(
    (
      await call(
        'm',
        'POST',
        '/api/tokens',
        { name: 'evil' },
        { Origin: 'https://evil.example.com' }
      )
    ).status,
    403,
    'tokens cannot be minted cross-origin'
  );

  const client = await connect(created.body.token);
  assert.equal(client.getServerVersion().name, 'mojobase');
  assert.match(client.getInstructions(), /InsForge-compatible/);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of [
    'create_project',
    'list_projects',
    'get_project',
    'get_integration_guide',
    'run_sql',
    'list_tables',
    'deploy_function',
    'create_bucket',
    'get_docs',
    'delete_project',
  ])
    assert.ok(names.includes(n), `missing tool ${n}`);
  assert.equal(tools.find((t) => t.name === 'delete_project').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'list_projects').annotations.readOnlyHint, true);

  const empty = await client.callTool({ name: 'list_projects', arguments: {} });
  assert.deepEqual(JSON.parse(empty.content[0].text), { projects: [] });

  // Email not confirmed yet: same rule as the website
  const early = await client.callTool({
    name: 'create_project',
    arguments: { name: 'From agent', wait: false },
  });
  assert.equal(early.isError, true);
  assert.match(early.content[0].text, /Confirm your email/);

  // Other users' projects are invisible
  const others = await call('a', 'GET', '/api/projects');
  void others;
  const foreign = await client.callTool({
    name: 'get_project',
    arguments: { ref: 'aaaaaaaaaaaaaaaa' },
  });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /Project not found/);

  // Revoked tokens stop working immediately
  assert.equal((await call('m', 'DELETE', `/api/tokens/${created.body.id}`)).status, 200);
  await assert.rejects(client.callTool({ name: 'list_projects', arguments: {} }));
  await client.close().catch(() => {});
});

test('the app shell revalidates on every load so deploys reach browsers at once', async () => {
  for (const p of ['/', '/app.js', '/styles.css', '/projects/abc'])
    assert.equal((await fetch(BASE + p)).headers.get('cache-control'), 'no-cache', p);
  // Script and stylesheet are linked by content hash, so changed files are never stale.
  const html = await (await fetch(BASE + '/projects/abc')).text();
  assert.match(html, /src="\/app\.js\?v=[0-9a-f]{12}"/);
  assert.match(html, /href="\/styles\.css\?v=[0-9a-f]{12}"/);
});
