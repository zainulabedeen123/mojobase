// Google Drive destination against a fake Google OAuth + Drive server (no
// network): consent URL, code exchange, token refresh, resumable uploads in
// chunks, run folders, pruning and the connection test.
import './helpers/env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers/env.js';
import { fakeGoogle } from './helpers/fake-google.js';

const g = await fakeGoogle();
Object.assign(process.env, g.env);
after(() => g.close());
const drive = await import('../src/offsite/gdrive.js');
(await import('../src/offsite/http.js'))._setRetryDelay(1);

test('consent URL asks for drive.file only, offline access and a fresh consent', () => {
  const u = new URL(drive.authorizationUrl('state-123'));
  assert.equal(u.origin + u.pathname, `${g.base}/auth`);
  assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(u.searchParams.get('access_type'), 'offline');
  assert.equal(u.searchParams.get('prompt'), 'consent');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('state'), 'state-123');
  assert.equal(
    u.searchParams.get('redirect_uri'),
    'http://localhost:39200/api/backups/gdrive/callback'
  );
  assert.equal(drive.driveConfigured(), true);
});

test('code exchange returns a refresh token; bad codes and revoked tokens fail clearly', async () => {
  g.state.codes.set('code-2', 'refresh-1');
  const t = await drive.exchangeCode('code-2');
  assert.equal(t.refreshToken, 'refresh-1');
  const sent = g.state.tokenRequests.at(-1);
  assert.equal(sent.grant_type, 'authorization_code');
  assert.equal(sent.redirect_uri, 'http://localhost:39200/api/backups/gdrive/callback');
  await assert.rejects(
    drive.exchangeCode('code-2'),
    /invalid_grant|revoked/,
    'codes are single use'
  );
  const revoked = new drive.DriveClient({ refreshToken: 'nope' });
  await assert.rejects(revoked.token(), /revoked or expired\. Reconnect Google Drive/);
});

test("resumable upload sends 256 KiB-aligned chunks and resumes from Google's offset", async () => {
  drive._setChunkSize(256 * 1024);
  try {
    const client = new drive.DriveClient({ refreshToken: 'refresh-1' });
    const folder = await client.ensureRootFolder('Uploads test');
    assert.equal(
      (await client.ensureRootFolder('Uploads test')).id,
      folder.id,
      'found, not duplicated'
    );
    const data = crypto.randomBytes(700 * 1024);
    const file = path.join(tmp, 'chunked.bin');
    fs.writeFileSync(file, data);
    const before = g.state.chunkRequests;
    await client.upload('chunked.bin', folder.id, { file, size: data.length });
    assert.equal(g.state.chunkRequests - before, 3);
    assert.deepEqual(g.fileAt('Uploads test/chunked.bin').body, data);
    // Empty files work too.
    await client.upload('empty.bin', folder.id, { buffer: Buffer.alloc(0), size: 0 });
    assert.equal(g.fileAt('Uploads test/empty.bin').body.length, 0);
  } finally {
    drive._setChunkSize(8 * 1024 * 1024);
  }
});

test('destination adapter: folders per project and run, listing, pruning, connection test', async () => {
  const dest = drive.driveDestination({
    refreshToken: 'refresh-1',
    folderName: 'Mojobase Backups',
  });
  const dump = path.join(tmp, 'database.dump');
  fs.writeFileSync(dump, 'PGDMP fake');
  const artifacts = [{ name: 'database.dump', path: dump, size: fs.statSync(dump).size }];
  const ref = 'qwertyuiopasdfgh';
  await dest.upload({ ref, projectFolder: `shop-${ref}`, stamp: '2026-02-01T0300Z' }, artifacts, {
    a: 1,
  });
  await dest.upload(
    { ref, projectFolder: `shop-renamed-${ref}`, stamp: '2026-02-01T1500Z' },
    artifacts,
    { a: 2 }
  );
  assert.deepEqual(
    g.paths().filter((p) => p.startsWith('Mojobase Backups/')),
    [
      `Mojobase Backups/shop-${ref}`,
      `Mojobase Backups/shop-${ref}/2026-02-01T0300Z`,
      `Mojobase Backups/shop-${ref}/2026-02-01T0300Z/database.dump`,
      `Mojobase Backups/shop-${ref}/2026-02-01T0300Z/manifest.json`,
      `Mojobase Backups/shop-${ref}/2026-02-01T1500Z`,
      `Mojobase Backups/shop-${ref}/2026-02-01T1500Z/database.dump`,
      `Mojobase Backups/shop-${ref}/2026-02-01T1500Z/manifest.json`,
    ],
    'a renamed project keeps using its existing folder'
  );
  assert.deepEqual(
    JSON.parse(g.fileAt(`Mojobase Backups/shop-${ref}/2026-02-01T1500Z/manifest.json`).body),
    { a: 2 }
  );
  const runs = await dest.listRuns(ref);
  assert.deepEqual(runs.map((r) => r.stamp).sort(), ['2026-02-01T0300Z', '2026-02-01T1500Z']);
  await dest.removeRun(runs.find((r) => r.stamp === '2026-02-01T0300Z'));
  assert.equal(
    g.paths().filter((p) => p.includes('2026-02-01T0300Z')).length,
    0,
    'run folder and its files removed'
  );
  assert.deepEqual(await dest.listRuns('nonexistentrefxx'), []);
  const count = g.state.files.size;
  await dest.test();
  assert.equal(g.state.files.size, count, 'test file written and deleted');
});

test("upload failures surface Drive's reason", async () => {
  g.state.failUploads = true;
  try {
    const dest = drive.driveDestination({ refreshToken: 'refresh-1', folderName: 'Quota' });
    await assert.rejects(dest.test(), /403/);
  } finally {
    g.state.failUploads = false;
  }
});
