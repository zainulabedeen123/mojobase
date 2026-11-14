// Project operations shared by the web console and the MCP server, so both
// enforce the same rules (limits, email confirmation, ownership).
import { config } from './config.js';
import { projects } from './store.js';
import {
  newRef,
  newSecrets,
  projectHost,
  connectionString,
  appContainer,
  DB_USER,
  DB_NAME,
} from './project-stack.js';
import { provision, destroy, dbCertReady } from './provisioner.js';

export class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[\p{L}\p{N} _.-]{1,40}$/u;

export function projectView(p, { withSecrets }) {
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

// Returns the project if `user` owns it, else throws 404 (never reveals other users' projects).
export function ownedProject(user, ref) {
  const p = projects.get(String(ref || ''));
  if (!p || p.owner_id !== user.id) throw new ServiceError(404, 'Project not found');
  return p;
}

export function createProject(user, rawName) {
  if (config.requireVerifiedEmail && !user.emailVerified)
    throw new ServiceError(403, 'Confirm your email address before creating a project');
  const name = String(rawName || '').trim();
  if (!NAME.test(name))
    throw new ServiceError(
      400,
      'Name must be 1–40 letters, numbers, spaces, dots, dashes or underscores'
    );
  if (projects.countForOwner(user.id) >= config.maxProjectsPerUser)
    throw new ServiceError(
      403,
      `Each account can have up to ${config.maxProjectsPerUser} projects`
    );
  if (projects.count() >= config.maxProjects)
    throw new ServiceError(503, 'Mojobase is at capacity right now. Please try again later.');
  if (!dbCertReady())
    throw new ServiceError(503, 'The platform is still starting up. Try again in a minute.');
  const used = projects.usedPorts();
  let dbPort = config.dbPortMin;
  while (used.has(dbPort) && dbPort <= config.dbPortMax) dbPort++;
  if (dbPort > config.dbPortMax) throw new ServiceError(503, 'No database ports left');
  let ref = newRef();
  while (projects.get(ref)) ref = newRef();
  projects.insert({
    ref,
    ownerId: user.id,
    name,
    status: 'provisioning',
    dbPort,
    secrets: newSecrets(),
  });
  provision(ref);
  return projects.get(ref);
}

export function deleteProject(user, ref) {
  const p = ownedProject(user, ref);
  projects.setStatus(p.ref, 'deleting');
  return destroy(p.ref);
}

// Calls a project's own API over the private docker network, as the project admin.
export async function projectApi(p, method, path, body, { timeoutMs = 60_000 } = {}) {
  if (p.status !== 'ready')
    throw new ServiceError(
      409,
      `Project is ${p.status}, not ready yet. Check it with get_project.`
    );
  let res;
  try {
    res = await fetch(`http://${appContainer(p.ref)}:7130${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${p.secrets.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ServiceError(
      502,
      `Could not reach the project backend: ${e.cause?.code || e.message}`
    );
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? data.message || data.error : String(data);
    throw new ServiceError(res.status, `Project API ${res.status}: ${String(msg).slice(0, 500)}`);
  }
  return data;
}
