import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { users, projects } from './store.js';
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
import {
  newRef,
  newSecrets,
  projectHost,
  connectionString,
  DB_USER,
  DB_NAME,
} from './project-stack.js';
import { provision, destroy, refreshDbCerts, resumePending, dbCertReady } from './provisioner.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal');
app.use(express.json({ limit: '16kb' }));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use('/api', sameOrigin);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME = /^[\p{L}\p{N} _.-]{1,40}$/u;
const authLimit = rateLimit({ windowMs: 60_000, max: 10 });

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
  setSession(res, id);
  res.status(201).json({ user: { id, email } });
});

app.post('/api/login', authLimit, (req, res) => {
  const email = String(req.body?.email || '')
    .trim()
    .toLowerCase();
  const user = users.byEmail(email);
  if (!user || !verifyPassword(String(req.body?.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  setSession(res, user.id);
  res.json({ user: { id: user.id, email: user.email } });
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
    signupOpen: config.allowSignup,
  });
});

// ------------------------------------------------------------------ projects
function view(p, { withSecrets }) {
  const base = {
    ref: p.ref,
    name: p.name,
    status: p.status,
    error: p.error,
    createdAt: p.created_at,
    apiUrl: `https://${projectHost(p.ref)}`,
    dashboardUrl: `https://${projectHost(p.ref)}/dashboard`,
  };
  if (!withSecrets) return base;
  const s = p.secrets;
  return {
    ...base,
    anonKey: s.anonKey,
    apiKey: s.apiKey,
    dashboard: { username: 'admin', password: s.adminPassword },
    database: {
      host: config.dbHost,
      port: p.db_port,
      database: DB_NAME,
      user: DB_USER,
      password: s.dbPassword,
      sslmode: 'require',
      connectionString: connectionString(p.ref, p.db_port, s),
    },
  };
}
function ownProject(req, res) {
  const p = projects.get(req.params.ref);
  if (!p || p.owner_id !== req.user.id) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return p;
}

app.get('/api/projects', requireUser, (req, res) => {
  res.json({
    projects: projects
      .forOwner(req.user.id)
      .map((p) => ({ ...p, apiUrl: `https://${projectHost(p.ref)}` })),
  });
});

app.post('/api/projects', requireUser, rateLimit({ windowMs: 60_000, max: 5 }), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!NAME.test(name))
    return res
      .status(400)
      .json({ error: 'Name must be 1–40 letters, numbers, spaces, dots, dashes or underscores' });
  if (projects.countForOwner(req.user.id) >= config.maxProjectsPerUser) {
    return res
      .status(403)
      .json({ error: `Each account can have up to ${config.maxProjectsPerUser} projects` });
  }
  if (projects.count() >= config.maxProjects) {
    return res
      .status(503)
      .json({ error: 'Mojobase is at capacity right now. Please try again later.' });
  }
  if (!dbCertReady())
    return res
      .status(503)
      .json({ error: 'The platform is still starting up. Try again in a minute.' });
  const used = projects.usedPorts();
  let dbPort = config.dbPortMin;
  while (used.has(dbPort) && dbPort <= config.dbPortMax) dbPort++;
  if (dbPort > config.dbPortMax) return res.status(503).json({ error: 'No database ports left' });
  let ref = newRef();
  while (projects.get(ref)) ref = newRef();
  projects.insert({
    ref,
    ownerId: req.user.id,
    name,
    status: 'provisioning',
    dbPort,
    secrets: newSecrets(),
  });
  provision(ref);
  res.status(202).json({ project: view(projects.get(ref), { withSecrets: false }) });
});

app.get('/api/projects/:ref', requireUser, (req, res) => {
  const p = ownProject(req, res);
  if (p) res.json({ project: view(p, { withSecrets: p.status === 'ready' }) });
});

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
internal.get('/healthz', (_req, res) => res.json({ ok: true, dbCert: dbCertReady() }));
internal.listen(config.internalPort);

resumePending();
refreshDbCerts();
setInterval(refreshDbCerts, 12 * 3600_000).unref();
