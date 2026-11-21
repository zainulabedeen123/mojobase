// Offsite backup runs end to end with fake destinations and fake dump/archive
// producers (no Docker, no network): manifest, uploads to every destination,
// failure isolation, retention pruning, scheduling, alerts, secrets at rest.
import './helpers/env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fakeS3 } from './helpers/fake-s3.js';
import { fakeGoogle } from './helpers/fake-google.js';

process.env.ALLOW_PRIVATE_S3_ENDPOINTS = '1';
const g = await fakeGoogle();
Object.assign(process.env, g.env);
const good = await fakeS3();
const bad = await fakeS3();
bad.state.fail = { status: 403, code: 'AccessDenied' };
after(async () => {
  await good.close();
  await bad.close();
  await g.close();
});

const { users, projects, offsite: store } = await import('../src/store.js');
const off = await import('../src/offsite/index.js');
(await import('../src/offsite/http.js'))._setRetryDelay(1);

let dumpFails = false;
const dumpBody = Buffer.from(`PGDMP${'x'.repeat(5000)}`);
const tarBody = Buffer.from('fake tar.gz contents');
off._setProducers({
  lock: (fn) => fn(),
  dumpDatabase: async (_ref, file) => {
    if (dumpFails) throw new Error('pg_dump exited 1: connection refused');
    fs.writeFileSync(file, dumpBody);
  },
  archiveStorage: async (_ref, file) => fs.writeFileSync(file, tarBody),
});
const alerts = [];
off._setNotifier(async (a) => {
  alerts.push(a);
  return true;
});

users.create('u1', 'owner@example.com', 'x');
const REF = 'abcdabcdabcdabcd';
projects.insert({
  ref: REF,
  ownerId: 'u1',
  name: 'My Shop',
  status: 'ready',
  dbPort: 15401,
  secrets: {},
});
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('settings: defaults are twice a day, 30 days, files included; input is validated', () => {
  const o = off.overview(REF);
  assert.deepEqual(o.settings, { hours: [3, 15], retentionDays: 30, includeFiles: true });
  assert.equal(o.nextRunAt, null, 'nothing scheduled without a destination');
  for (const body of [
    { hours: [], retentionDays: 30, includeFiles: true },
    { hours: [24], retentionDays: 30, includeFiles: true },
    { hours: [3, 3], retentionDays: 30, includeFiles: true },
    { hours: [1.5], retentionDays: 30, includeFiles: true },
    { hours: [3], retentionDays: 0, includeFiles: true },
    { hours: [3], retentionDays: 30, includeFiles: 'yes' },
    { hours: [3], retentionDays: 30, includeFiles: true, extra: 1 },
  ])
    assert.throws(
      () => off.saveSettings(REF, body),
      (e) => e.status === 400,
      JSON.stringify(body)
    );
  assert.deepEqual(
    off.saveSettings(REF, { hours: [15, 3], retentionDays: 30, includeFiles: true }).settings.hours,
    [3, 15]
  );
});

let okId;
let badId;
test('destinations: validated, secrets encrypted at rest and never in views', () => {
  assert.throws(
    () =>
      off.addDestination(REF, {
        type: 's3',
        label: 'x',
        config: { ...good.config(), bucket: 'a' },
      }),
    /bucket/
  );
  assert.throws(
    () => off.addDestination(REF, { type: 'gdrive', label: 'x', config: {} }),
    (e) => e.status === 400
  );
  assert.throws(
    () => off.addDestination(REF, { type: 's3', label: '<b>', config: good.config() }),
    /label/
  );
  const okDest = off.addDestination(REF, {
    type: 's3',
    label: 'R2 primary',
    config: good.config(),
  });
  const badDest = off.addDestination(REF, {
    type: 's3',
    label: 'Broken bucket',
    config: bad.config(),
  });
  okId = okDest.id;
  badId = badDest.id;
  const view = JSON.stringify(off.overview(REF));
  assert.ok(!view.includes(good.config().secretAccessKey), 'secret not in view');
  assert.ok(!view.includes(good.config().accessKeyId), 'access key id not in view');
  assert.equal(okDest.config.hasSecret, true);
  assert.match(okDest.config.accessKeyId, /^••••/);
  // At rest: the sqlite row holds ciphertext only.
  const db = new DatabaseSync(path.join(process.env.DATA_DIR, 'console.db'), { readOnly: true });
  const rows = db.prepare('SELECT config FROM offsite_destinations').all();
  db.close();
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(!r.config.includes(good.config().secretAccessKey));
    assert.ok(!r.config.includes('AKTEST'));
    assert.ok(!r.config.includes('endpoint'));
  }
  // Editing without a secret keeps the saved one.
  off.updateDestination(REF, okId, {
    label: 'R2',
    config: { secretAccessKey: '', region: 'auto' },
  });
  assert.equal(store.destination(REF, okId).config.secretAccessKey, good.config().secretAccessKey);
  assert.equal(store.destination(REF, okId).label, 'R2');
  assert.throws(
    () => off.updateDestination(REF, 'nope', {}),
    (e) => e.status === 404
  );
});

test('a run uploads dump, files and manifest; one failing destination does not stop the other', async () => {
  // An expired run (40 days old), a recent one and an unrelated folder in the good bucket.
  const old = new Date(Date.now() - 40 * 86400_000);
  const recent = new Date(Date.now() - 10 * 86400_000);
  const base = `mojobase/my-shop-${REF}`;
  good.put('backups', `${base}/${off.runStamp(old)}/database.dump`, 'old');
  good.put('backups', `${base}/${off.runStamp(old)}/manifest.json`, '{}');
  good.put('backups', `${base}/${off.runStamp(recent)}/database.dump`, 'recent');
  good.put('backups', `${base}/notes/readme.txt`, 'keep me');

  const { runId, done } = off.startRun(REF, { trigger: 'manual' });
  assert.throws(() => off.startRun(REF), /already running/);
  const run = await done;
  assert.equal(run.id, runId);
  assert.equal(run.status, 'partial');
  const byLabel = Object.fromEntries(run.targets.map((t) => [t.label, t]));
  assert.equal(byLabel.R2.status, 'ok');
  assert.ok(byLabel.R2.bytes > dumpBody.length + tarBody.length);
  assert.match(byLabel.R2.note, /Removed 1 backup older than 30 days/);
  assert.equal(byLabel['Broken bucket'].status, 'failed');
  assert.match(byLabel['Broken bucket'].error, /403 AccessDenied/);

  const stamp = run.folder.split('/')[1];
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{4}Z$/);
  const keys = good.keys();
  assert.deepEqual(
    keys.filter((k) => k.includes(stamp)),
    [
      `${base}/${stamp}/database.dump`,
      `${base}/${stamp}/manifest.json`,
      `${base}/${stamp}/storage.tar.gz`,
    ]
  );
  assert.ok(!keys.some((k) => k.includes(off.runStamp(old))), 'expired run pruned');
  assert.ok(keys.includes(`${base}/${off.runStamp(recent)}/database.dump`), 'recent run kept');
  assert.ok(keys.includes(`${base}/notes/readme.txt`), 'unknown folders never touched');
  assert.deepEqual(good.get('backups', `${base}/${stamp}/database.dump`), dumpBody);

  const manifest = JSON.parse(good.get('backups', `${base}/${stamp}/manifest.json`));
  assert.equal(manifest.project.ref, REF);
  assert.equal(manifest.project.name, 'My Shop');
  assert.equal(manifest.mojobaseVersion, '0.1.0');
  assert.deepEqual(
    manifest.artifacts.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    [
      { name: 'database.dump', size: dumpBody.length, sha256: sha(dumpBody) },
      { name: 'storage.tar.gz', size: tarBody.length, sha256: sha(tarBody) },
    ]
  );
  assert.equal(alerts.length, 0, 'manual runs do not email');
  assert.deepEqual(
    fs.readdirSync(path.join(process.env.DATA_DIR, 'offsite-staging')),
    [],
    'staging cleaned up'
  );
  const hist = off.overview(REF).runs;
  assert.equal(hist[0].id, runId);
  assert.equal(hist[0].targets.length, 2);
});

test('include_files off uploads only the database dump; disabled destinations are skipped', async () => {
  off.saveSettings(REF, { hours: [3, 15], retentionDays: 30, includeFiles: false });
  off.updateDestination(REF, badId, { enabled: false });
  const run = await off.startRun(REF).done;
  assert.equal(run.status, 'ok');
  assert.equal(run.targets.length, 1);
  assert.deepEqual(
    run.artifacts.map((a) => a.name),
    ['database.dump']
  );
  off.saveSettings(REF, { hours: [3, 15], retentionDays: 30, includeFiles: true });
  off.updateDestination(REF, badId, { enabled: true });
});

test('Google Drive and S3 destinations side by side', async () => {
  store.insertDestination({
    id: crypto.randomUUID(),
    ref: REF,
    type: 'gdrive',
    label: 'Drive',
    enabled: true,
    config: { refreshToken: 'refresh-1', folderName: 'Mojobase Backups' },
  });
  const run = await off.startRun(REF).done;
  const drive = run.targets.find((t) => t.type === 'gdrive');
  assert.equal(drive.status, 'ok');
  const stamp = run.folder.split('/')[1];
  assert.ok(g.fileAt(`Mojobase Backups/my-shop-${REF}/${stamp}/database.dump`));
  assert.ok(g.fileAt(`Mojobase Backups/my-shop-${REF}/${stamp}/storage.tar.gz`));
  const view = JSON.stringify(off.overview(REF));
  assert.ok(!view.includes('refresh-1'), 'refresh token never in views');
});

test('retention: only run folders older than the cutoff, never the current one', () => {
  const now = Date.UTC(2026, 10, 21, 3, 0);
  const runs = [
    '2026-10-21T0300Z',
    '2026-10-22T0259Z',
    '2026-10-22T0300Z',
    '2026-11-21T0300Z',
    'notes',
    '2026-13-01T0000Z',
  ].map((stamp) => ({ id: stamp, stamp }));
  const expired = off.selectExpired(runs, {
    now,
    retentionDays: 30,
    keepStamp: '2026-11-21T0300Z',
  });
  assert.deepEqual(
    expired.map((r) => r.stamp),
    ['2026-10-21T0300Z', '2026-10-22T0259Z']
  );
  assert.deepEqual(
    off.selectExpired([{ stamp: '2020-01-01T0000Z' }], {
      now,
      retentionDays: 30,
      keepStamp: '2020-01-01T0000Z',
    }),
    []
  );
});

test('scheduler: runs at the chosen UTC hours, once per slot', async () => {
  assert.equal(off.isDue(new Date('2026-11-21T03:04:00Z'), [3, 15], null), true);
  assert.equal(off.isDue(new Date('2026-11-21T03:59:00Z'), [3, 15], '2026-11-21T03'), false);
  assert.equal(off.isDue(new Date('2026-11-21T04:00:00Z'), [3, 15], '2026-11-21T03'), false);
  assert.equal(off.isDue(new Date('2026-11-21T15:00:00Z'), [3, 15], '2026-11-21T03'), true);
  assert.equal(off.isDue(new Date('2026-11-22T03:00:00Z'), [3], '2026-11-21T03'), true);
  assert.equal(
    off.nextRunAt([3, 15], new Date('2026-11-21T03:10:00Z')),
    '2026-11-21T15:00:00.000Z'
  );
  assert.equal(
    off.nextRunAt([3, 15], new Date('2026-11-21T16:00:00Z')),
    '2026-11-22T03:00:00.000Z'
  );
  assert.equal(off.nextRunAt([0], new Date('2026-11-21T00:00:00Z')), '2026-11-22T00:00:00.000Z');

  off.saveSettings(REF, { hours: [6], retentionDays: 30, includeFiles: true });
  assert.deepEqual(off.tick(new Date('2026-11-21T05:55:00Z')), [], 'not the hour');
  const started = off.tick(new Date('2026-11-21T06:01:00Z'));
  assert.equal(started.length, 1);
  assert.deepEqual(off.tick(new Date('2026-11-21T06:06:00Z')), [], 'same slot, still running');
  while (off.isRunning(REF)) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(off.tick(new Date('2026-11-21T06:11:00Z')), [], 'same slot never repeats');
  const run = off.overview(REF).runs.find((r) => r.id === started[0]);
  assert.equal(run.trigger, 'scheduled');
});

test('failure alerts: scheduled failures email the owner at most once a day', async () => {
  // The previous scheduled run had a failing destination -> one alert.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].to, 'owner@example.com');
  assert.equal(alerts[0].project.ref, REF);
  assert.ok(alerts[0].run.targets.some((t) => t.status === 'failed'));
  // Another failing scheduled run the same day: no second email.
  dumpFails = true;
  const started = off.tick(new Date('2026-11-22T06:01:00Z'));
  while (off.isRunning(REF)) await new Promise((r) => setTimeout(r, 20));
  const run = off.overview(REF).runs.find((r) => r.id === started[0]);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /Backup could not be created: pg_dump exited 1/);
  assert.ok(run.targets.every((t) => t.status === 'failed'));
  assert.equal(alerts.length, 1, 'rate limited');
  // A day later it emails again.
  store.setLastAlert(REF, Date.now() - 25 * 3600_000);
  const again = off.tick(new Date('2026-11-23T06:01:00Z'));
  assert.equal(again.length, 1);
  while (off.isRunning(REF)) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alerts.length, 2);
  dumpFails = false;
});

test('a project that is not ready is not backed up', () => {
  projects.setStatus(REF, 'paused');
  assert.deepEqual(off.tick(new Date('2026-11-24T06:01:00Z')), []);
  assert.throws(() => off.startRun(REF), /not ready/);
  projects.setStatus(REF, 'ready');
});

test('interrupted runs are marked failed after a restart', () => {
  store.insertRun({
    id: 'r-stale',
    ref: REF,
    trigger: 'scheduled',
    startedAt: new Date().toISOString(),
  });
  off.recover();
  const r = off.overview(REF, { runs: 50 }).runs.find((x) => x.id === 'r-stale');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /restart/);
});

test('deleting a project removes its offsite settings, destinations and history', () => {
  projects.remove(REF);
  assert.equal(store.destinations(REF).length, 0);
  assert.equal(store.runs(REF).length, 0);
});
