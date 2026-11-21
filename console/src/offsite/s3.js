// S3-compatible destination (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO…)
// over plain HTTPS with SigV4. Files above 50 MB go up as multipart uploads.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { request, validateEndpoint, withRetry, httpError } from './http.js';
import { sign, sha256Hex, EMPTY_SHA256, uriEncode, canonicalUri } from './sigv4.js';

let multipartThreshold = 50 * 1024 * 1024;
export const _setMultipartThreshold = (n) => (multipartThreshold = n);
let partSize = 16 * 1024 * 1024; // S3 minimum is 5 MiB (except the last part)
export const _setPartSize = (n) => (partSize = n);

const xmlUnescape = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const xmlEscape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]
  );
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlUnescape(m[1]) : null;
};
const tags = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

export class S3Client {
  // cfg: { endpoint, region, bucket, accessKeyId, secretAccessKey, pathStyle }
  constructor(cfg) {
    this.cfg = cfg;
    this.base = validateEndpoint(cfg.endpoint);
    this.region = cfg.region || 'us-east-1';
  }

  // Host and raw (unencoded) path for an object key ('' = the bucket itself).
  target(key = '') {
    const { bucket, pathStyle } = this.cfg;
    const basePath = decodeURIComponent(this.base.pathname.replace(/\/+$/, ''));
    if (pathStyle) return { host: this.base.host, path: `${basePath}/${bucket}/${key}` };
    return { host: `${bucket}.${this.base.host}`, path: `${basePath}/${key}` };
  }

  async send({
    method,
    key = '',
    query = [],
    headers = {},
    body,
    payloadHash = EMPTY_SHA256,
    okStatus = [200],
  }) {
    const { host, path } = this.target(key);
    const signed = sign({
      method,
      path,
      query,
      headers: { host, ...headers },
      payloadHash,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.region,
    });
    const qs = query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v ?? '')}`).join('&');
    const url = new URL(`${this.base.protocol}//${host}${canonicalUri(path)}${qs ? `?${qs}` : ''}`);
    const res = await request({
      method,
      url,
      headers: signed.headers,
      body,
      guard: true,
      timeoutMs: 10 * 60_000,
    });
    if (!okStatus.includes(res.status)) {
      const xml = res.body.toString('utf8');
      const code = tag(xml, 'Code');
      const msg = tag(xml, 'Message');
      throw httpError(
        `S3 ${method} returned ${res.status}${code ? ` ${code}` : ''}${msg ? `: ${msg.slice(0, 200)}` : ''}`,
        res.status
      );
    }
    return res;
  }

  // Uploads a local file. sha256 (hex) of the whole file is known in advance
  // (it is in the manifest), which lets a single PUT stream from disk.
  async putFile(key, file, { size, sha256 }) {
    if (size > multipartThreshold) return this.multipartUpload(key, file, size);
    return withRetry(() =>
      this.send({
        method: 'PUT',
        key,
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream' },
        payloadHash: sha256,
        body: fs.createReadStream(file),
      })
    );
  }

  putBuffer(key, buf, contentType = 'application/octet-stream') {
    return withRetry(() =>
      this.send({
        method: 'PUT',
        key,
        headers: { 'content-length': String(buf.length), 'content-type': contentType },
        payloadHash: sha256Hex(buf),
        body: buf,
      })
    );
  }

  async multipartUpload(key, file, size) {
    const init = await withRetry(() =>
      this.send({
        method: 'POST',
        key,
        query: [['uploads', '']],
        headers: { 'content-type': 'application/octet-stream' },
      })
    );
    const uploadId = tag(init.body.toString('utf8'), 'UploadId');
    if (!uploadId) throw new Error('S3 did not return an UploadId');
    const parts = [];
    const fh = await fs.promises.open(file, 'r');
    try {
      for (let offset = 0, n = 1; offset < size; offset += partSize, n++) {
        const len = Math.min(partSize, size - offset);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, offset);
        if (bytesRead !== len) throw new Error('File changed while uploading');
        const hash = sha256Hex(buf);
        const res = await withRetry(() =>
          this.send({
            method: 'PUT',
            key,
            query: [
              ['partNumber', String(n)],
              ['uploadId', uploadId],
            ],
            headers: { 'content-length': String(len) },
            payloadHash: hash,
            body: buf,
          })
        );
        const etag = res.headers.etag;
        if (!etag) throw new Error(`S3 returned no ETag for part ${n}`);
        parts.push({ n, etag });
      }
      const xml = `<CompleteMultipartUpload>${parts
        .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const done = await withRetry(() =>
        this.send({
          method: 'POST',
          key,
          query: [['uploadId', uploadId]],
          headers: {
            'content-type': 'application/xml',
            'content-length': String(Buffer.byteLength(xml)),
          },
          payloadHash: sha256Hex(xml),
          body: xml,
        })
      );
      // S3 can answer 200 with an error document for CompleteMultipartUpload.
      const body = done.body.toString('utf8');
      if (/<Error>/.test(body))
        throw new Error(`S3 multipart upload failed: ${tag(body, 'Code') || 'error'}`);
      return { parts: parts.length };
    } catch (e) {
      await this.send({
        method: 'DELETE',
        key,
        query: [['uploadId', uploadId]],
        okStatus: [200, 204, 404],
      }).catch(() => {});
      throw e;
    } finally {
      await fh.close();
    }
  }

  // ListObjectsV2, all pages. Returns { keys: [{ key, size }], prefixes: [] }.
  async list(prefix, { delimiter } = {}) {
    const keys = [];
    const prefixes = [];
    let token = null;
    for (let page = 0; page < 1000; page++) {
      const query = [
        ['list-type', '2'],
        ['prefix', prefix],
        ['max-keys', '1000'],
      ];
      if (delimiter) query.push(['delimiter', delimiter]);
      if (token) query.push(['continuation-token', token]);
      const res = await withRetry(() => this.send({ method: 'GET', query }));
      const xml = res.body.toString('utf8');
      for (const c of tags(xml, 'Contents'))
        keys.push({ key: tag(c, 'Key'), size: Number(tag(c, 'Size') || 0) });
      for (const c of tags(xml, 'CommonPrefixes')) prefixes.push(tag(c, 'Prefix'));
      if (tag(xml, 'IsTruncated') !== 'true') break;
      token = tag(xml, 'NextContinuationToken');
      if (!token) break;
    }
    return { keys, prefixes };
  }

  remove(key) {
    return withRetry(() => this.send({ method: 'DELETE', key, okStatus: [200, 204, 404] }));
  }
}

// Key prefix inside the bucket for everything Mojobase writes.
export function rootPrefix(cfg) {
  const p = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');
  return `${p ? `${p}/` : ''}mojobase/`;
}

// Destination adapter used by the backup runner.
export function s3Destination(cfg) {
  const client = new S3Client(cfg);
  const root = rootPrefix(cfg);
  return {
    // Uploads the run's files (manifest last) into <root><name>-<ref>/<stamp>/.
    // where: { ref, projectFolder: '<name>-<ref>', stamp }
    async upload(where, artifacts, manifest) {
      const folder = `${where.projectFolder}/${where.stamp}`;
      let bytes = 0;
      for (const a of artifacts) {
        await client.putFile(`${root}${folder}/${a.name}`, a.path, a);
        bytes += a.size;
      }
      const buf = Buffer.from(JSON.stringify(manifest, null, 2));
      await client.putBuffer(`${root}${folder}/manifest.json`, buf, 'application/json');
      return { bytes: bytes + buf.length };
    },
    // Run folders of this project (under any name it had): [{ id, stamp }]
    async listRuns(ref) {
      const { prefixes } = await client.list(root, { delimiter: '/' });
      const runs = [];
      for (const pf of prefixes.filter((p) => p.endsWith(`-${ref}/`) || p === `${root}${ref}/`)) {
        const { prefixes: stamps } = await client.list(pf, { delimiter: '/' });
        for (const s of stamps) runs.push({ id: s, stamp: s.slice(pf.length).replace(/\/$/, '') });
      }
      return runs;
    },
    async removeRun(run) {
      const { keys } = await client.list(run.id);
      for (const k of keys) await client.remove(k.key);
    },
    async test() {
      const key = `${root}.mojobase-connection-test-${crypto.randomBytes(6).toString('hex')}`;
      await client.putBuffer(key, Buffer.from('Mojobase connection test\n'), 'text/plain');
      await client.remove(key);
    },
  };
}
