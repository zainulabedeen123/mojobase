// Offsite backups: each run takes a database dump (pg_dump -Fc), a tar.gz of the
// project's uploaded files and a manifest, uploads them to every enabled
// destination of the project (Google Drive, S3-compatible storage), then prunes
// that destination's runs older than the retention period.
//
// Destination secrets (S3 keys, Google refresh tokens) are stored encrypted
// (store.js) and never leave the server: views only carry masked hints.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { config } from '../config.js';
import { projects, users, offsite, OFFSITE_DEFAULTS } from '../store.js';
import { sendEmail } from '../mailer.js';
import { signValue, verifySignedValue } from '../signing.js';
import { s3Destination } from './s3.js';
import { EndpointError, validateEndpoint } from './http.js';
import {
  driveDestination,
  driveConfigured,
  authorizationUrl,
  exchangeCode,
  DriveClient,
} from './gdrive.js';

export class OffsiteError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const log = (ref, msg, extra) => console.log(JSON.stringify({ level: 'info', ref, msg, ...extra }));
export const MAX_DESTINATIONS = 5;
const stagingRoot = () => path.join(config.dataDir, 'offsite-staging');

// ------------------------------------------------------------------ validation
const LABEL = /^[\p{L}\p{N} _.()'-]{1,40}$/u;
const FOLDER_NAME = /^[\p{L}\p{N} _.()'-]{1,80}$/u;
const label = z.string().trim().regex(LABEL, 'Use 1–40 letters, numbers, spaces or . _ - ( )');
const folderName = z
  .string()
  .trim()
  .regex(FOLDER_NAME, 'Use 1–80 letters, numbers, spaces or . _ - ( )');

export const settingsSchema = z
  .object({
    hours: z
      .array(z.number().int().min(0).max(23))
      .min(1, 'Pick at least one hour')
      .max(24)
      .refine((h) => new Set(h).size === h.length, 'Each hour only once'),
    retentionDays: z.number().int().min(1).max(3650),
    includeFiles: z.boolean(),
  })
  .strict();

const s3Fields = {
  endpoint: z.string().trim().min(1, 'Endpoint is required').max(300),
  region: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9-]*$/, 'Region looks like us-east-1 or auto'),
  bucket: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/, 'Enter a valid bucket name'),
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9!_.*'()/-]*$/, "Prefix may use letters, numbers and / ! _ . * ' ( ) -")
    .refine((p) => !p.split('/').includes('..'), 'Prefix must not contain ..'),
  accessKeyId: z.string().trim().min(1, 'Access key ID is required').max(256),
  secretAccessKey: z.string().min(1, 'Secret access key is required').max(512),
  pathStyle: z.boolean(),
};
const s3Config = z
  .object({
    ...s3Fields,
    region: s3Fields.region.default(''),
    prefix: s3Fields.prefix.default(''),
    pathStyle: s3Fields.pathStyle.default(false),
  })
  .strict();
// On edit, an empty or missing secret keeps the saved one.
const s3ConfigPatch = z
  .object({
    ...Object.fromEntries(Object.entries(s3Fields).map(([k, v]) => [k, v.optional()])),
    accessKeyId: z.string().trim().max(256).optional(),
    secretAccessKey: z.string().max(512).optional(),
  })
  .strict();

export const createDestinationSchema = z
  .object({ type: z.literal('s3'), label, enabled: z.boolean().default(true), config: s3Config })
  .strict();
const patchDestinationSchema = z
  .object({
    label: label.optional(),
    enabled: z.boolean().optional(),
    config: z
      .union([s3ConfigPatch, z.object({ folderName: folderName.optional() }).strict()])
      .optional(),
  })
  .strict();
export const driveConnectSchema = z
  .object({
    label: label.default('Google Drive'),
    folderName: folderName.default('Mojobase Backups'),
    destinationId: z.string().uuid().optional(),
  })
  .strict();

function parse(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue.path.filter((p) => typeof p === 'string').at(-1);
  throw new OffsiteError(400, where ? `${where}: ${issue.message}` : issue.message);
}

function checkEndpoint(endpoint) {
  try {
    return validateEndpoint(endpoint).toString().replace(/\/$/, '');
  } catch (e) {
    if (e instanceof EndpointError) throw new OffsiteError(400, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ views (no secrets)
const maskTail = (s) => (s ? `••••${String(s).slice(-4)}` : '');
export function destinationView(d) {
  const c = d.config;
  const base = {
    id: d.id,
    type: d.type,
    label: d.label,
    enabled: d.enabled,
    createdAt: d.created_at,
  };
  if (d.type === 's3')
    return {
      ...base,
      config: {
        endpoint: c.endpoint,
        region: c.region,
        bucket: c.bucket,
        prefix: c.prefix,
        pathStyle: !!c.pathStyle,
        accessKeyId: maskTail(c.accessKeyId),
        hasSecret: !!c.secretAccessKey,
      },
    };
  return {
    ...base,
    config: { folderName: c.folderName, account: c.account || null, connected: !!c.refreshToken },
  };
}

const runView = (r) => ({
  id: r.id,
  trigger: r.trigger,
  status: r.status,
  folder: r.folder,
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  artifacts: r.artifacts.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  targets: r.targets.map((t) => ({
    destinationId: t.destination_id,
    type: t.type,
    label: t.label,
    status: t.status,
    bytes: t.bytes,
    durationMs: t.duration_ms,
    error: t.error,
    note: t.note,
  })),
});

export function nextRunAt(hours, now = new Date()) {
  if (!hours.length) return null;
  const t = new Date(now);
  t.setUTCMinutes(0, 0, 0);
  for (let i = 1; i <= 25; i++) {
    t.setUTCHours(t.getUTCHours() + 1);
    if (hours.includes(t.getUTCHours())) return t.toISOString();
  }
  return null;
}

export function overview(ref, { runs = 10 } = {}) {
  const s = offsite.settings(ref);
  const destinations = offsite.destinations(ref);
  const active = destinations.some((d) => d.enabled);
  return {
    settings: { hours: s.hours, retentionDays: s.retentionDays, includeFiles: s.includeFiles },
    defaults: OFFSITE_DEFAULTS,
    destinations: destinations.map(destinationView),
    runs: offsite.runs(ref, runs).map(runView),
    running: running.has(ref),
    nextRunAt: active ? nextRunAt(s.hours) : null,
    googleDrive: { configured: driveConfigured() },
    maxDestinations: MAX_DESTINATIONS,
  };
}

// Short status for the MCP server / API.
export function summary(ref) {
  const [last] = offsite.runs(ref, 1).map(runView);
  const s = offsite.settings(ref);
  const destinations = offsite.destinations(ref);
  return {
    destinations: destinations.map((d) => ({ type: d.type, label: d.label, enabled: d.enabled })),
    hoursUtc: s.hours,
    retentionDays: s.retentionDays,
    nextRunAt: destinations.some((d) => d.enabled) ? nextRunAt(s.hours) : null,
    lastRun: last
      ? {
          status: last.status,
          startedAt: last.startedAt,
          finishedAt: last.finishedAt,
          error: last.error,
          targets: last.targets.map(({ label: l, status, error }) => ({ label: l, status, error })),
        }
      : null,
  };
}

// ------------------------------------------------------------------ settings / destinations
export function saveSettings(ref, body) {
  const s = parse(settingsSchema, body);
  s.hours = [...s.hours].sort((a, b) => a - b);
  offsite.saveSettings(ref, s);
  return overview(ref);
}

export function addDestination(ref, body) {
  const d = parse(createDestinationSchema, body);
  if (offsite.countDestinations(ref) >= MAX_DESTINATIONS)
    throw new OffsiteError(409, `You can add up to ${MAX_DESTINATIONS} destinations`);
  d.config.endpoint = checkEndpoint(d.config.endpoint);
  const id = crypto.randomUUID();
  offsite.ensureSettings(ref);
  offsite.insertDestination({
    id,
    ref,
    type: d.type,
    label: d.label,
    enabled: d.enabled,
    config: d.config,
  });
  return destinationView(offsite.destination(ref, id));
}

export function updateDestination(ref, id, body) {
  const d = offsite.destination(ref, id);
  if (!d) throw new OffsiteError(404, 'Destination not found');
  const patch = parse(patchDestinationSchema, body);
  let cfg = d.config;
  if (patch.config) {
    if (d.type === 's3') {
      const c = parse(s3ConfigPatch, patch.config);
      const merged = { ...cfg };
      for (const [k, v] of Object.entries(c)) {
        if ((k === 'secretAccessKey' || k === 'accessKeyId') && !v) continue; // keep saved
        merged[k] = v;
      }
      merged.endpoint = checkEndpoint(merged.endpoint);
      cfg = merged;
    } else {
      const c = parse(z.object({ folderName: folderName.optional() }).strict(), patch.config);
      cfg = { ...cfg, ...c };
    }
  }
  offsite.updateDestination(ref, id, {
    label: patch.label ?? d.label,
    enabled: patch.enabled ?? d.enabled,
    config: cfg,
  });
  return destinationView(offsite.destination(ref, id));
}

export function removeDestination(ref, id) {
  if (!offsite.removeDestination(ref, id)) throw new OffsiteError(404, 'Destination not found');
}

const adapters = { s3: s3Destination, gdrive: driveDestination };
const adapterFor = (d) => adapters[d.type](d.config);

export async function testDestination(ref, id) {
  const d = offsite.destination(ref, id);
  if (!d) throw new OffsiteError(404, 'Destination not found');
  const started = Date.now();
  try {
    await adapterFor(d).test();
    return { ok: true, durationMs: Date.now() - started };
  } catch (e) {
    return { ok: false, error: cleanError(e) };
  }
}

// Error text safe to store and show: never echoes credentials.
function cleanError(e) {
  let msg = String(e?.message || e || 'Unknown error');
  if (e?.code && !msg.includes(e.code)) msg = `${msg} (${e.code})`;
  return msg
    .replace(/(Signature|Credential|access_token|refresh_token)=[^\s&,]+/gi, '$1=…')
    .slice(0, 500);
}

// ------------------------------------------------------------------ Google Drive OAuth
export function startDriveConnect(user, ref, body) {
  if (!driveConfigured())
    throw new OffsiteError(409, 'Google Drive is not configured on this server');
  const opts = parse(driveConnectSchema, body);
  if (opts.destinationId) {
    const d = offsite.destination(ref, opts.destinationId);
    if (!d || d.type !== 'gdrive') throw new OffsiteError(404, 'Destination not found');
  } else if (offsite.countDestinations(ref) >= MAX_DESTINATIONS)
    throw new OffsiteError(409, `You can add up to ${MAX_DESTINATIONS} destinations`);
  const raw = offsite.issueState(user.id, ref, opts);
  return { url: authorizationUrl(signValue(raw)) };
}

// Handles the redirect back from Google. Returns { ref } to send the browser to.
export async function finishDriveConnect(user, query) {
  const raw = verifySignedValue(String(query.state || ''));
  if (!raw) throw new OffsiteError(400, 'Invalid sign-in state. Start again from the console.');
  const state = offsite.consumeState(raw);
  if (!state) throw new OffsiteError(400, 'This sign-in link has expired or was already used.');
  if (state.userId !== user.id)
    throw new OffsiteError(403, 'This sign-in was started by another account.');
  const p = projects.get(state.ref);
  if (!p || p.owner_id !== user.id) throw new OffsiteError(404, 'Project not found');
  const fail = (msg) => Object.assign(new OffsiteError(400, msg), { ref: p.ref });
  if (query.error)
    throw fail(
      query.error === 'access_denied'
        ? 'Google Drive access was not granted.'
        : 'Google sign-in failed.'
    );
  if (typeof query.code !== 'string' || !query.code || query.code.length > 2048)
    throw fail('Google did not return an authorization code.');
  let tokens;
  try {
    tokens = await exchangeCode(query.code);
    // Make sure the backup folder can be created before saving anything.
    const client = new DriveClient(tokens);
    await client.ensureRootFolder(state.payload.folderName);
    tokens.account = await client
      .api('GET', '/drive/v3/about', { query: { fields: 'user(emailAddress)' } })
      .then((r) => JSON.parse(r.body.toString('utf8')).user?.emailAddress || null)
      .catch(() => null);
  } catch (e) {
    throw fail(cleanError(e));
  }
  const cfg = {
    refreshToken: tokens.refreshToken,
    folderName: state.payload.folderName,
    account: tokens.account,
  };
  const existing =
    state.payload.destinationId && offsite.destination(p.ref, state.payload.destinationId);
  if (existing) {
    offsite.updateDestination(p.ref, existing.id, {
      label: existing.label,
      enabled: existing.enabled,
      config: cfg,
    });
  } else {
    if (offsite.countDestinations(p.ref) >= MAX_DESTINATIONS)
      throw fail(`You can add up to ${MAX_DESTINATIONS} destinations`);
    offsite.ensureSettings(p.ref);
    offsite.insertDestination({
      id: crypto.randomUUID(),
      ref: p.ref,
      type: 'gdrive',
      label: state.payload.label,
      enabled: true,
      config: cfg,
    });
  }
  log(p.ref, 'google drive connected');
  return { ref: p.ref };
}

// ------------------------------------------------------------------ runs
export const runStamp = (d) =>
  d
    .toISOString()
    .replace(/:\d{2}\.\d{3}Z$/, 'Z')
    .replace(/:/g, '');
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z$/;
const stampTime = (s) => {
  const m = STAMP.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
};
export function slug(name) {
  const s = String(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'project';
}

// Runs (from a destination listing) that are past retention. Folders whose name
// is not a run stamp are never touched, nor is the run just uploaded.
export function selectExpired(runs, { now = Date.now(), retentionDays, keepStamp }) {
  const cutoff = now - retentionDays * 86400_000;
  return runs.filter((r) => {
    const t = stampTime(r.stamp);
    return t !== null && r.stamp !== keepStamp && t < cutoff;
  });
}

async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return { size: fs.statSync(file).size, sha256: hash.digest('hex') };
}

// Producers of the run's files; tests replace them (no Docker there).
let producers = null;
async function defaultProducers() {
  const prov = await import('../provisioner.js');
  return {
    lock: prov.withBackupLock,
    dumpDatabase: prov.dumpDatabase,
    archiveStorage: prov.archiveStorage,
  };
}
export const _setProducers = (p) => (producers = p);
let notifier = defaultNotifier;
export const _setNotifier = (fn) => (notifier = fn);

const running = new Set(); // refs with a run queued or in progress
let queue = Promise.resolve(); // one run at a time keeps disk and bandwidth bounded

export const isRunning = (ref) => running.has(ref);

// Queues a run. Returns { runId, done } right away; `done` resolves with the run.
export function startRun(ref, { trigger = 'manual' } = {}) {
  const p = projects.get(ref);
  if (!p) throw new OffsiteError(404, 'Project not found');
  if (p.status !== 'ready') throw new OffsiteError(409, 'Project is not ready');
  if (!offsite.destinations(ref).some((d) => d.enabled))
    throw new OffsiteError(409, 'Add an offsite destination first');
  if (running.has(ref))
    throw new OffsiteError(409, 'An offsite backup of this project is already running');
  running.add(ref);
  const runId = crypto.randomUUID();
  offsite.insertRun({ id: runId, ref, trigger, startedAt: new Date().toISOString() });
  const job = () => executeRun(ref, runId, trigger).finally(() => running.delete(ref));
  const done = (queue = queue.then(job, job));
  queue = queue.catch(() => {});
  return { runId, done };
}

async function executeRun(ref, runId, trigger) {
  const started = new Date();
  const stamp = runStamp(started);
  const staging = path.join(stagingRoot(), runId);
  const p = projects.get(ref);
  const settings = offsite.settings(ref);
  const destinations = offsite.destinations(ref).filter((d) => d.enabled);
  const projectFolder = `${slug(p?.name || ref)}-${ref}`;
  offsite.updateRun(runId, { folder: `${projectFolder}/${stamp}` });
  for (const d of destinations)
    offsite.setTarget({
      runId,
      destinationId: d.id,
      type: d.type,
      label: d.label,
      status: 'running',
    });
  let artifacts = [];
  try {
    if (!p || p.status !== 'ready') throw new Error('Project is not ready');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    const prod = producers || (await defaultProducers());
    const files = [{ name: 'database.dump', kind: 'database', make: prod.dumpDatabase }];
    if (settings.includeFiles)
      files.push({ name: 'storage.tar.gz', kind: 'storage', make: prod.archiveStorage });
    await prod.lock(async () => {
      for (const f of files) await f.make(ref, path.join(staging, f.name));
    });
    for (const f of files) {
      const file = path.join(staging, f.name);
      artifacts.push({ name: f.name, kind: f.kind, path: file, ...(await fileDigest(file)) });
    }
  } catch (e) {
    const error = `Backup could not be created: ${cleanError(e)}`;
    for (const d of destinations)
      offsite.setTarget({
        runId,
        destinationId: d.id,
        type: d.type,
        label: d.label,
        status: 'failed',
        error: 'Not uploaded: the backup could not be created',
      });
    offsite.updateRun(runId, { status: 'failed', error, finishedAt: new Date().toISOString() });
    fs.rmSync(staging, { recursive: true, force: true });
    log(ref, 'offsite backup failed', { error });
    await maybeAlert(ref, runId, trigger);
    return offsite
      .runs(ref, 50)
      .map(runView)
      .find((r) => r.id === runId);
  }

  const manifest = {
    format: 'mojobase-offsite-backup',
    formatVersion: 1,
    mojobaseVersion: config.mojobaseVersion,
    project: { ref, name: p.name },
    createdAt: started.toISOString(),
    trigger,
    artifacts: artifacts.map(({ name, kind, size, sha256 }) => ({ name, kind, size, sha256 })),
    restore: {
      database: 'pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" database.dump',
      storage: 'tar xzf storage.tar.gz -C <storage directory>',
    },
  };
  offsite.updateRun(runId, { artifacts: manifest.artifacts });

  // Each destination on its own: one failing never stops the others.
  let ok = 0;
  for (const d of destinations) {
    const t0 = Date.now();
    try {
      const adapter = adapterFor(d);
      const { bytes } = await adapter.upload({ ref, projectFolder, stamp }, artifacts, manifest);
      let note = null;
      try {
        const expired = selectExpired(await adapter.listRuns(ref), {
          retentionDays: settings.retentionDays,
          keepStamp: stamp,
        });
        for (const r of expired) await adapter.removeRun(r);
        if (expired.length)
          note = `Removed ${expired.length} backup${expired.length === 1 ? '' : 's'} older than ${settings.retentionDays} days`;
      } catch (e) {
        note = `Uploaded, but old backups could not be removed: ${cleanError(e)}`;
      }
      offsite.setTarget({
        runId,
        destinationId: d.id,
        type: d.type,
        label: d.label,
        status: 'ok',
        bytes,
        durationMs: Date.now() - t0,
        note,
      });
      ok++;
    } catch (e) {
      const error = cleanError(e);
      offsite.setTarget({
        runId,
        destinationId: d.id,
        type: d.type,
        label: d.label,
        status: 'failed',
        durationMs: Date.now() - t0,
        error,
      });
      log(ref, 'offsite upload failed', { destination: d.id, type: d.type, error });
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const status = ok === destinations.length ? 'ok' : ok === 0 ? 'failed' : 'partial';
  offsite.updateRun(runId, {
    status,
    error:
      status === 'ok'
        ? null
        : `${destinations.length - ok} of ${destinations.length} destinations failed`,
    finishedAt: new Date().toISOString(),
  });
  offsite.trimRuns(ref);
  log(ref, 'offsite backup finished', { status, run: runId });
  if (status !== 'ok') await maybeAlert(ref, runId, trigger);
  return offsite
    .runs(ref, 50)
    .map(runView)
    .find((r) => r.id === runId);
}

// ------------------------------------------------------------------ failure alerts
const ALERT_INTERVAL = 24 * 3600_000;
async function maybeAlert(ref, runId, trigger, now = Date.now()) {
  if (trigger !== 'scheduled') return false; // manual runs show the result on screen
  const s = offsite.settings(ref);
  if (s.lastAlertAt && now - s.lastAlertAt < ALERT_INTERVAL) return false;
  const p = projects.get(ref);
  const owner = p && users.byId(p.owner_id);
  if (!owner) return false;
  const run = offsite
    .runs(ref, 50)
    .map(runView)
    .find((r) => r.id === runId);
  try {
    if (await notifier({ to: owner.email, project: p, run })) {
      offsite.setLastAlert(ref, now);
      return true;
    }
  } catch (e) {
    log(ref, 'offsite alert email failed', { error: e.message });
  }
  return false;
}

async function defaultNotifier({ to, project, run }) {
  if (!config.resendApiKey) return false; // email not configured
  const failed = run.targets.filter((t) => t.status !== 'ok');
  const details = failed.length
    ? failed.map((t) => `${t.label}: ${t.error || 'failed'}`).join('; ')
    : run.error || 'The backup could not be created.';
  await sendEmail({
    to,
    subject: `Offsite backup failed for ${project.name}`,
    heading: `Offsite backup failed for ${project.name}`,
    body: `The scheduled offsite backup at ${run.startedAt.slice(0, 16).replace('T', ' ')} UTC did not reach every destination. ${details}`.slice(
      0,
      1200
    ),
    cta: 'Open backup settings',
    url: `${config.consoleOrigin}/projects/${project.ref}?offsite=open`,
    footnote:
      'You get at most one of these emails per project per day. Local backups on the server are not affected.',
  });
  return true;
}

// ------------------------------------------------------------------ scheduler
// A run is due when the current UTC hour is one of the project's hours and
// that hour's slot has not run yet (the slot is stored, so restarts don't repeat it).
export const slotOf = (now) => now.toISOString().slice(0, 13);
export function isDue(now, hours, lastSlot) {
  return hours.includes(now.getUTCHours()) && lastSlot !== slotOf(now);
}

export function tick(now = new Date()) {
  const started = [];
  for (const ref of offsite.scheduledRefs()) {
    const p = projects.get(ref);
    if (!p || p.status !== 'ready' || running.has(ref)) continue;
    const s = offsite.settings(ref);
    if (!isDue(now, s.hours, s.lastSlot)) continue;
    offsite.setLastSlot(ref, slotOf(now));
    try {
      const { runId, done } = startRun(ref, { trigger: 'scheduled' });
      done.catch((e) => log(ref, 'offsite backup crashed', { error: e.message }));
      started.push(runId);
    } catch (e) {
      log(ref, 'offsite backup not started', { error: e.message });
    }
  }
  return started;
}

// After a restart: runs that were in flight are marked failed, staging is cleared.
export function recover() {
  offsite.failInterrupted();
  fs.rmSync(stagingRoot(), { recursive: true, force: true });
}
