// In-memory S3-compatible server (path-style) for tests. It checks every
// request's SigV4 signature and that x-amz-content-sha256 matches the body.
import http from 'node:http';
import crypto from 'node:crypto';
import { sign } from '../../src/offsite/sigv4.js';

const xml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

export async function fakeS3({
  accessKeyId = 'AKTEST',
  secretAccessKey = 'sekret/KEY+1',
  region = 'auto',
  pageSize = 1000,
} = {}) {
  const objects = new Map(); // `${bucket}/${key}` -> Buffer
  const uploads = new Map(); // uploadId -> { key, parts: Map }
  const state = { objects, uploads, requests: [], fail: null, badSignatures: 0 };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      state.requests.push({ method: req.method, path: url.pathname, query: url.search });
      const error = (status, code, message = code) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`
        );
      };
      if (state.fail)
        return error(state.fail.status || 403, state.fail.code || 'AccessDenied', 'Access Denied');

      // ---- signature check
      const auth = req.headers.authorization || '';
      const m =
        /Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(
          auth
        );
      if (!m || m[1] !== accessKeyId || m[3] !== region) return error(403, 'InvalidAccessKeyId');
      const signedNames = m[4].split(';');
      const headers = Object.fromEntries(signedNames.map((n) => [n, req.headers[n]]));
      const amz = req.headers['x-amz-date'];
      const date = new Date(
        `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`
      );
      const query = [...url.searchParams.entries()];
      const expected = sign({
        method: req.method,
        path: decodeURIComponent(url.pathname),
        query,
        headers,
        payloadHash: req.headers['x-amz-content-sha256'],
        accessKeyId,
        secretAccessKey,
        region,
        date,
      });
      if (expected.signature !== m[5]) {
        state.badSignatures++;
        return error(403, 'SignatureDoesNotMatch');
      }
      const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
      if (req.headers['x-amz-content-sha256'] !== bodyHash)
        return error(400, 'XAmzContentSHA256Mismatch');

      // ---- operations
      const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
      const key = rest.join('/');
      const q = url.searchParams;
      const id = `${bucket}/${key}`;
      const etag = `"${crypto.createHash('md5').update(body).digest('hex')}"`;
      if (req.method === 'PUT' && q.has('partNumber')) {
        const up = uploads.get(q.get('uploadId'));
        if (!up) return error(404, 'NoSuchUpload');
        up.parts.set(Number(q.get('partNumber')), { body, etag });
        res.writeHead(200, { etag });
        return res.end();
      }
      if (req.method === 'PUT') {
        objects.set(id, body);
        res.writeHead(200, { etag });
        return res.end();
      }
      if (req.method === 'POST' && q.has('uploads')) {
        const uploadId = crypto.randomUUID();
        uploads.set(uploadId, { key: id, parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${xml(key)}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
        );
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        const up = uploads.get(q.get('uploadId'));
        if (!up) return error(404, 'NoSuchUpload');
        const listed = [
          ...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g),
        ];
        const parts = listed.map(([, n, e]) => {
          const p = up.parts.get(Number(n));
          if (!p || p.etag !== e.replace(/&quot;/g, '"')) throw new Error('bad part');
          return p.body;
        });
        objects.set(up.key, Buffer.concat(parts));
        uploads.delete(q.get('uploadId'));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          `<CompleteMultipartUploadResult><Key>${xml(key)}</Key></CompleteMultipartUploadResult>`
        );
      }
      if (req.method === 'DELETE' && q.has('uploadId')) {
        uploads.delete(q.get('uploadId'));
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'DELETE') {
        objects.delete(id);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET' && q.get('list-type') === '2') {
        const prefix = q.get('prefix') || '';
        const delimiter = q.get('delimiter');
        const start = Number(q.get('continuation-token') || 0);
        const keys = [...objects.keys()]
          .filter((k) => k.startsWith(`${bucket}/`))
          .map((k) => k.slice(bucket.length + 1))
          .filter((k) => k.startsWith(prefix))
          .sort();
        const entries = [];
        const seen = new Set();
        for (const k of keys) {
          const restKey = k.slice(prefix.length);
          const i = delimiter ? restKey.indexOf(delimiter) : -1;
          if (i >= 0) {
            const cp = prefix + restKey.slice(0, i + 1);
            if (!seen.has(cp)) entries.push({ prefix: cp }), seen.add(cp);
          } else entries.push({ key: k });
        }
        const page = entries.slice(start, start + pageSize);
        const truncated = start + pageSize < entries.length;
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><IsTruncated>${truncated}</IsTruncated>` +
            (truncated
              ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>`
              : '') +
            page
              .map((e) =>
                e.key
                  ? `<Contents><Key>${xml(e.key)}</Key><Size>${objects.get(`${bucket}/${e.key}`).length}</Size></Contents>`
                  : `<CommonPrefixes><Prefix>${xml(e.prefix)}</Prefix></CommonPrefixes>`
              )
              .join('') +
            '</ListBucketResult>'
        );
      }
      error(400, 'NotImplemented');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  return {
    ...state,
    state,
    endpoint,
    config: (bucket = 'backups', extra = {}) => ({
      endpoint,
      region,
      bucket,
      prefix: '',
      accessKeyId,
      secretAccessKey,
      pathStyle: true,
      ...extra,
    }),
    keys: (bucket = 'backups') =>
      [...objects.keys()]
        .filter((k) => k.startsWith(`${bucket}/`))
        .map((k) => k.slice(bucket.length + 1))
        .sort(),
    get: (bucket, key) => objects.get(`${bucket}/${key}`),
    put: (bucket, key, body) => objects.set(`${bucket}/${key}`, Buffer.from(body)),
    close: () => new Promise((r) => server.close(r)),
  };
}
