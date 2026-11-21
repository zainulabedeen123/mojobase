// S3-compatible client against a fake S3 server (no network): signed single
// PUTs, multipart uploads, paginated listing, deletes, run folders and pruning.
import './helpers/env.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers/env.js';
import { fakeS3 } from './helpers/fake-s3.js';

process.env.ALLOW_PRIVATE_S3_ENDPOINTS = '1'; // the fake server listens on 127.0.0.1
const { S3Client, s3Destination, _setPartSize, _setMultipartThreshold } = await import(
  '../src/offsite/s3.js'
);
const { validateEndpoint, isPrivateAddress, _setRetryDelay } = await import(
  '../src/offsite/http.js'
);
_setRetryDelay(1);

const s3 = await fakeS3({ pageSize: 2 });
after(() => s3.close());
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const writeFile = (name, buf) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return { path: p, name, size: buf.length, sha256: sha(buf) };
};

test('single PUT streams a file with its sha256 as the signed payload hash', async () => {
  const client = new S3Client(s3.config());
  const f = writeFile('small.bin', crypto.randomBytes(3000));
  await client.putFile('dir/small file+1.bin', f.path, f);
  assert.deepEqual(s3.get('backups', 'dir/small file+1.bin'), fs.readFileSync(f.path));
  assert.equal(s3.state.badSignatures, 0);
});

test('large files go up as a multipart upload', async () => {
  _setMultipartThreshold(1024 * 1024);
  _setPartSize(256 * 1024);
  try {
    const client = new S3Client(s3.config());
    const f = writeFile('big.bin', crypto.randomBytes(1024 * 1024 + 12345));
    const before = s3.state.requests.length;
    const r = await client.putFile('big.bin', f.path, f);
    assert.equal(r.parts, 5);
    assert.deepEqual(s3.get('backups', 'big.bin'), fs.readFileSync(f.path));
    const ops = s3.state.requests.slice(before);
    assert.ok(ops[0].query.includes('uploads'));
    assert.equal(ops.filter((o) => o.query.includes('partNumber')).length, 5);
    assert.equal(s3.state.uploads.size, 0);
  } finally {
    _setMultipartThreshold(50 * 1024 * 1024);
    _setPartSize(16 * 1024 * 1024);
  }
});

test('a failed multipart upload is aborted', async () => {
  _setMultipartThreshold(1024);
  _setPartSize(1024);
  const client = new S3Client(s3.config());
  const f = writeFile('abort.bin', crypto.randomBytes(5000));
  const orig = client.send.bind(client);
  let parts = 0;
  client.send = (args) => {
    if (args.query?.some(([k]) => k === 'partNumber') && ++parts === 3)
      return Promise.reject(Object.assign(new Error('boom'), { permanent: true }));
    return orig(args);
  };
  try {
    await assert.rejects(client.putFile('abort.bin', f.path, f), /boom/);
    assert.equal(s3.state.uploads.size, 0, 'upload aborted');
    assert.equal(s3.get('backups', 'abort.bin'), undefined);
  } finally {
    _setMultipartThreshold(50 * 1024 * 1024);
    _setPartSize(16 * 1024 * 1024);
  }
});

test('listing follows continuation tokens; delete removes objects', async () => {
  const client = new S3Client(s3.config('listing'));
  for (const k of ['a/1', 'a/2', 'a/3', 'b/1', 'c']) s3.put('listing', k, k);
  const all = await client.list('');
  assert.deepEqual(
    all.keys.map((k) => k.key),
    ['a/1', 'a/2', 'a/3', 'b/1', 'c']
  );
  const top = await client.list('', { delimiter: '/' });
  assert.deepEqual(top.prefixes, ['a/', 'b/']);
  assert.deepEqual(
    top.keys.map((k) => k.key),
    ['c']
  );
  await client.remove('a/2');
  assert.deepEqual(s3.keys('listing'), ['a/1', 'a/3', 'b/1', 'c']);
});

test('errors carry the S3 error code; wrong secret fails the signature check', async () => {
  const client = new S3Client({ ...s3.config(), secretAccessKey: 'wrong' });
  await assert.rejects(client.remove('x'), /403 SignatureDoesNotMatch/);
});

test('destination adapter: run folders, listing across renames, removal, connection test', async () => {
  const cfg = s3.config('dest', { prefix: 'team/x/' });
  const dest = s3Destination(cfg);
  const a = writeFile('database.dump', Buffer.from('PGDMP...'));
  const manifest = { project: { ref: 'abcdefabcdefabcd' } };
  const r = await dest.upload(
    {
      ref: 'abcdefabcdefabcd',
      projectFolder: 'my-app-abcdefabcdefabcd',
      stamp: '2026-01-02T0300Z',
    },
    [a],
    manifest
  );
  assert.equal(r.bytes, a.size + Buffer.byteLength(JSON.stringify(manifest, null, 2)));
  // An older run stored while the project had another name, and another project.
  s3.put('dest', 'team/x/mojobase/old-name-abcdefabcdefabcd/2025-12-01T0300Z/database.dump', 'x');
  s3.put('dest', 'team/x/mojobase/other-zzzzzzzzzzzzzzzz/2025-12-01T0300Z/database.dump', 'x');
  assert.deepEqual(s3.keys('dest'), [
    'team/x/mojobase/my-app-abcdefabcdefabcd/2026-01-02T0300Z/database.dump',
    'team/x/mojobase/my-app-abcdefabcdefabcd/2026-01-02T0300Z/manifest.json',
    'team/x/mojobase/old-name-abcdefabcdefabcd/2025-12-01T0300Z/database.dump',
    'team/x/mojobase/other-zzzzzzzzzzzzzzzz/2025-12-01T0300Z/database.dump',
  ]);
  const runs = await dest.listRuns('abcdefabcdefabcd');
  assert.deepEqual(runs.map((x) => x.stamp).sort(), ['2025-12-01T0300Z', '2026-01-02T0300Z']);
  await dest.removeRun(runs.find((x) => x.stamp === '2025-12-01T0300Z'));
  assert.equal(s3.keys('dest').length, 3);
  assert.ok(
    s3
      .keys('dest')
      .includes('team/x/mojobase/other-zzzzzzzzzzzzzzzz/2025-12-01T0300Z/database.dump')
  );
  const before = s3.keys('dest');
  await dest.test();
  assert.deepEqual(s3.keys('dest'), before, 'test object written and removed');
  assert.ok(
    s3.state.requests.some(
      (q) => q.method === 'PUT' && q.path.includes('.mojobase-connection-test-')
    )
  );
});

test('virtual-hosted and path-style addressing', () => {
  const v = new S3Client({
    ...s3.config(),
    endpoint: 'https://s3.eu-west-1.amazonaws.com',
    pathStyle: false,
  });
  assert.deepEqual(v.target('a b/c'), {
    host: 'backups.s3.eu-west-1.amazonaws.com',
    path: '/a b/c',
  });
  const p = new S3Client({
    ...s3.config(),
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    pathStyle: true,
  });
  assert.deepEqual(p.target('k'), { host: 'acct.r2.cloudflarestorage.com', path: '/backups/k' });
});

test('SSRF guard: endpoints must be public https hosts', () => {
  const bad = [
    'http://s3.amazonaws.com',
    'https://127.0.0.1',
    'https://10.1.2.3:9000',
    'https://169.254.169.254/latest',
    'https://[::1]',
    'https://[fd00::1]',
    'https://[::ffff:192.168.1.1]',
    'https://localhost',
    'https://minio',
    'https://metadata.google.internal',
    'https://user:pw@s3.amazonaws.com',
    'ftp://s3.amazonaws.com',
    'not a url',
  ];
  for (const u of bad)
    assert.throws(() => validateEndpoint(u, { allowPrivate: false }), undefined, u);
  for (const u of [
    'https://s3.amazonaws.com',
    'https://acct.r2.cloudflarestorage.com',
    'https://s3.us-west-004.backblazeb2.com',
    'https://8.8.8.8',
  ])
    assert.doesNotThrow(() => validateEndpoint(u, { allowPrivate: false }), u);
  // With ALLOW_PRIVATE_S3_ENDPOINTS=1 a local MinIO is fine.
  assert.doesNotThrow(() => validateEndpoint('http://127.0.0.1:9000', { allowPrivate: true }));
  for (const ip of [
    '100.64.0.1',
    '172.20.0.5',
    '192.168.0.1',
    '0.0.0.0',
    'fe80::1',
    '::',
    '::ffff:7f00:1',
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '2606:4700:4700::1111'])
    assert.equal(isPrivateAddress(ip), false, ip);
});

test('without GOOGLE_DRIVE_CLIENT_ID/SECRET, Google Drive is reported as not configured', async () => {
  const off = await import('../src/offsite/index.js');
  const { users, projects } = await import('../src/store.js');
  users.create('u-nd', 'nd@example.com', 'x');
  projects.insert({
    ref: 'nodrivenodrive00',
    ownerId: 'u-nd',
    name: 'X',
    status: 'ready',
    dbPort: 15499,
    secrets: {},
  });
  assert.equal(off.overview('nodrivenodrive00').googleDrive.configured, false);
  assert.throws(
    () => off.startDriveConnect({ id: 'u-nd' }, 'nodrivenodrive00', {}),
    /not configured on this server/
  );
});
