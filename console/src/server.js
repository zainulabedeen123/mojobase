import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { users, projects, tokens, accessTokens } from './store.js';
import { emails } from './mailer.js';
import {
  hashPassword,
  verifyPassword,
  setSession,
  clearSession,
  currentUser,
  requireUser,
  sameOrigin,
  rateLimit,
} from './auth.js';
import { projectHost } from './project-stack.js';
import {
  projectView,
  createProject,
  renameProject,
  setPaused,
  projectUsage,
  ServiceError,
} from './projects-service.js';
import { jwks, signProjectAuthorization } from './signing.js';
import { handleMcp } from './mcp.js';
import {
  provision,
  destroy,
  refreshDbCerts,
  resumePending,
  dbCertReady,
  backupProject,
  listBackups,
  backupPath,
  scheduleBackups,
  deleteBackup,
  renameBackup,
  restoreBackup,
  reconcileProjects,
} from './provisioner.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');
// MCP endpoint: bearer-token auth only (no cookies), so cross-origin use is fine.
app.use('/mcp', (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use('/mcp', express.json({ limit: '2mb' }));
app.all('/mcp', (req, res, next) => handleMcp(req, res).catch(next));

app.use('/api', express.json({ limit: '16kb' }));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Lets embedded project dashboards see the console's origin (and nothing more).
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-src https://*.${config.baseDomain}; frame-ancestors 'none'`,
  });
  next();
});
app.use('/api', sameOrigin);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME = /^[\p{L}\p{N} _.-]{1,40}$/u;
const authLimit = rateLimit({ windowMs: 60_000, max: config.authRateLimit });

// ------------------------------------------------------------------ account
app.post('/api/signup', authLimit, (req, res) => {
  if (!config.allowSignup) return res.status(403).json({ error: 'Sign-up is currently closed' });
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const password = String(req.body?.password || '');
  if (!EMAIL.test(email) || email.length > 200)
    return res.status(400).json({ error: 'Enter a valid email address' });
  if (password.length < 10 || password.length > 200)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  if (users.byEmail(email))
    return res.status(409).json({ error: 'An account with this email already exists' });
  const id = crypto.randomUUID();
  users.create(id, email, hashPassword(password));
  setSession(res, users.withHash(id));
  sendVerification(id, email);
  res.status(201).json({ user: { id, email, emailVerified: false } });
});

const VERIFY_TTL = 24 * 3600_000;
const RESET_TTL = 3600_000;
function sendVerification(userId, email) {
  const token = tokens.issue(userId, 'verify', VERIFY_TTL);
  emails
    .verify(email, `${config.consoleOrigin}/verify?token=${token}`)
    .catch((e) =>
      console.error(
        JSON.stringify({ level: 'error', msg: 'verify email failed', error: e.message })
      )
    );
}

app.post('/api/verify', authLimit, (req, res) => {
  const userId = tokens.consume(req.body?.token, 'verify');
  if (!userId) return res.status(400).json({ error: 'This link is invalid or has expired' });
  users.setVerified(userId);
  res.json({ ok: true });
});

app.post(
  '/api/resend-verification',
  requireUser,
  rateLimit({ windowMs: 60_000, max: 2 }),
  (req, res) => {
    if (!req.user.emailVerified) sendVerification(req.user.id, req.user.email);
    res.json({ ok: true });
  }
);

// Always answers the same way so it can't be used to discover which emails have accounts.
app.post('/api/forgot-password', authLimit, async (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const user = EMAIL.test(email) ? users.byEmail(email) : null;
  if (user) {
    const token = tokens.issue(user.id, 'reset', RESET_TTL);
    await emails
      .reset(user.email, `${config.consoleOrigin}/reset-password?token=${token}`)
      .catch((e) =>
        console.error(
          JSON.stringify({ level: 'error', msg: 'reset email failed', error: e.message })
        )
      );
  }
  res.json({ ok: true });
});

app.post('/api/reset-password', authLimit, (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 10 || password.length > 200)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  const userId = tokens.consume(req.body?.token, 'reset');
  if (!userId) return res.status(400).json({ error: 'This link is invalid or has expired' });
  users.setPassword(userId, hashPassword(password)); // also signs out every other session
  users.setVerified(userId); // the link proved they own the address
  setSession(res, users.withHash(userId));
  res.json({ ok: true });
});

// Deletes every project (stacks, data, backups) and then the account itself.
app.post('/api/account/delete', requireUser, authLimit, async (req, res) => {
  const user = users.withHash(req.user.id);
  if (!verifyPassword(String(req.body?.password || ''), user.password_hash))
    return res.status(401).json({ error: 'Incorrect password' });
  const refs = projects.refsForOwner(user.id);
  for (const ref of refs) projects.setStatus(ref, 'deleting');
  await Promise.all(refs.map((ref) => destroy(ref)));
  if (projects.refsForOwner(user.id).length)
    return res
      .status(500)
      .json({ error: 'Some projects could not be deleted. Try again in a minute.' });
  users.remove(user.id);
  clearSession(res);
  res.json({ ok: true });
});

app.post('/api/login', authLimit, (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const user = users.byEmail(email);
  if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  setSession(res, user);
  res.json({ user: { id: user.id, email: user.email, emailVerified: !!user.email_verified } });
});

app.post('/api/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({
    user,
    limits: { perUser: config.maxProjectsPerUser },
    requireVerifiedEmail: config.requireVerifiedEmail,
    signupOpen: config.allowSignup,
  });
});

// ------------------------------------------------------------------ projects
const view = projectView;
function ownProject(req, res) {
  const p = projects.get(req.params.ref);
  if (!p || p.owner_id !== req.user.id) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return p;
}

app.get('/api/projects', requireUser, async (req, res) => {
  const list = projects.forOwner(req.user.id);
  const withUsage = await Promise.all(
    list.map(async (row) => ({
      ...row,
      apiUrl: `https://${projectHost(row.ref)}`,
      usage: await projectUsage(projects.get(row.ref)),
    }))
  );
  res.json({ projects: withUsage });
});

app.post('/api/projects', requireUser, rateLimit({ windowMs: 60_000, max: 5 }), (req, res) => {
  try {
    const p = createProject(req.user, req.body?.name);
    res.status(202).json({ project: view(p, { withSecrets: false }) });
  } catch (e) {
    if (e instanceof ServiceError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// ------------------------------------------------------------------ access tokens (MCP / API)
app.get('/api/tokens', requireUser, (req, res) => {
  res.json({ tokens: accessTokens.forUser(req.user.id) });
});
app.post('/api/tokens', requireUser, rateLimit({ windowMs: 60_000, max: 10 }), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!NAME.test(name))
    return res.status(400).json({ error: 'Give the token a name (1–40 characters)' });
  if (accessTokens.countForUser(req.user.id) >= 10)
    return res.status(403).json({ error: 'You can have up to 10 access tokens' });
  const { id, token } = accessTokens.create(req.user.id, name);
  res.status(201).json({ id, name, token });
});
app.delete('/api/tokens/:id', requireUser, (req, res) => {
  if (!accessTokens.revoke(req.user.id, req.params.id))
    return res.status(404).json({ error: 'Token not found' });
  res.json({ ok: true });
});

app.get('/api/projects/:ref', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (p) res.json({ project: view(p, { withSecrets: p.status === 'ready' }) });
});

// Helper for routes that call the shared project service.
const service = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof ServiceError) return res.status(e.status).json({ error: e.message });
    console.error(JSON.stringify({ level: 'error', msg: e.message }));
    res.status(500).json({ error: e.message || 'Something went wrong' });
  }
};

// A short-lived signed code the embedded project dashboard exchanges for an
// admin session on that project (same protocol InsForge Cloud uses).
app.post(
  '/api/projects/:ref/authorization-code',
  requireUser,
  rateLimit({ windowMs: 60_000, max: 30 }),
  (req, res) => {
    const p = ownProject(req, res);
    if (!p) return;
    if (p.status !== 'ready') return res.status(409).json({ error: `Project is ${p.status}` });
    res.json({ code: signProjectAuthorization({ userId: req.user.id, projectRef: p.ref }) });
  }
);

app.patch(
  '/api/projects/:ref',
  requireUser,
  service(async (req, res) => {
    const p = renameProject(req.user, req.params.ref, req.body?.name);
    res.json({ project: view(p, { withSecrets: false }) });
  })
);
app.post(
  '/api/projects/:ref/pause',
  requireUser,
  service(async (req, res) => {
    res.json({
      project: view(await setPaused(req.user, req.params.ref, true), { withSecrets: false }),
    });
  })
);
app.post(
  '/api/projects/:ref/resume',
  requireUser,
  service(async (req, res) => {
    res.status(202).json({
      project: view(await setPaused(req.user, req.params.ref, false), { withSecrets: false }),
    });
  })
);

app.post('/api/projects/:ref/retry', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  if (p.status !== 'failed')
    return res.status(409).json({ error: 'Only failed projects can be retried' });
  projects.setStatus(p.ref, 'provisioning');
  provision(p.ref);
  res.status(202).json({ ok: true });
});

app.delete('/api/projects/:ref', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  projects.setStatus(p.ref, 'deleting');
  destroy(p.ref);
  res.status(202).json({ ok: true });
});

app.get('/api/projects/:ref/backups', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (p)
    res.json({
      backups: listBackups(p.ref),
      keep: config.backupKeep,
      hourUtc: config.backupHourUtc,
    });
});
app.post(
  '/api/projects/:ref/backups',
  requireUser,
  rateLimit({ windowMs: 60_000, max: 2 }),
  async (req, res) => {
    const p = ownProject(req, res);
    if (!p) return;
    if (p.status !== 'ready') return res.status(409).json({ error: 'Project is not ready' });
    try {
      const name = req.body?.name ? String(req.body.name).slice(0, 80) : null;
      res
        .status(201)
        .json({ file: await backupProject(p.ref, { name, createdBy: req.user.email }) });
    } catch (e) {
      res.status(500).json({ error: `Backup failed: ${e.message}` });
    }
  }
);
app.get('/api/projects/:ref/backups/:file', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  const file = backupPath(p.ref, req.params.file);
  if (!file) return res.status(404).json({ error: 'Backup not found' });
  res.download(file, req.params.file);
});

app.delete('/api/projects/:ref/backups/:file', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  if (!deleteBackup(p.ref, req.params.file))
    return res.status(404).json({ error: 'Backup not found' });
  res.json({ ok: true });
});
app.patch('/api/projects/:ref/backups/:file', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (!p) return;
  const name = String(req.body?.name || '')
    .trim()
    .slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!renameBackup(p.ref, req.params.file, name))
    return res.status(404).json({ error: 'Backup not found' });
  res.json({ ok: true });
});
app.post(
  '/api/projects/:ref/backups/:file/restore',
  requireUser,
  rateLimit({ windowMs: 60_000, max: 2 }),
  async (req, res) => {
    const p = ownProject(req, res);
    if (!p) return;
    try {
      await restoreBackup(p.ref, req.params.file);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Restore failed: ${e.message}` });
    }
  }
);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express needs 4 args to treat this as the error handler
app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', msg: err.message }));
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong' });
});

// ------------------------------------------------------------------ web app
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.use(express.static(pub, { index: 'index.html', maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(pub, 'index.html')));

app.listen(config.port, () =>
  console.log(JSON.stringify({ level: 'info', msg: `console listening on ${config.port}` }))
);

// ------------------------------------------------------------------ internal (Caddy only)
// Caddy asks before issuing an on-demand certificate: only real project hosts get one.
const internal = express();
internal.get('/tls-ask', (req, res) => {
  const domain = String(req.query.domain || '').toLowerCase();
  const suffix = `.${config.baseDomain}`;
  const ref = domain.endsWith(suffix) ? domain.slice(0, -suffix.length) : '';
  res.sendStatus(/^[a-z][a-z0-9]{15}$/.test(ref) && projects.exists(ref) ? 200 : 404);
});
// Public keys for the project-authorization codes (projects use this as their CLOUD_API_HOST JWKS).
internal.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
internal.get('/healthz', (_req, res) => res.json({ ok: true, dbCert: dbCertReady() }));
internal.listen(config.internalPort);

resumePending();
reconcileProjects();
scheduleBackups();
setInterval(() => tokens.purgeExpired(), 3600_000).unref();
refreshDbCerts();
setInterval(refreshDbCerts, 12 * 3600_000).unref();
