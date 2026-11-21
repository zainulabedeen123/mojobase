// Google Drive destination. OAuth 2.0 web flow with the drive.file scope: the
// console can only see and change files it created itself, never the rest of
// the user's Drive. Uploads use Drive's resumable protocol in 8 MiB chunks.
import fs from 'node:fs';
import { config } from '../config.js';
import { request, withRetry, httpError } from './http.js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER = 'application/vnd.google-apps.folder';
let chunkSize = 8 * 1024 * 1024; // must be a multiple of 256 KiB
export const _setChunkSize = (n) => (chunkSize = n);

export const driveConfigured = () =>
  !!(config.googleDrive.clientId && config.googleDrive.clientSecret);
export const redirectUri = () => `${config.consoleOrigin}/api/backups/gdrive/callback`;

export function authorizationUrl(state) {
  const u = new URL(config.googleDrive.authUrl);
  u.search = new URLSearchParams({
    client_id: config.googleDrive.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'false',
    state,
  }).toString();
  return u.toString();
}

async function tokenRequest(params) {
  const body = new URLSearchParams({
    client_id: config.googleDrive.clientId,
    client_secret: config.googleDrive.clientSecret,
    ...params,
  }).toString();
  const res = await request({
    method: 'POST',
    url: config.googleDrive.tokenUrl,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs: 30_000,
  });
  let json = {};
  try {
    json = JSON.parse(res.body.toString('utf8'));
  } catch {
    /* not JSON */
  }
  if (res.status !== 200) {
    if (json.error === 'invalid_grant')
      throw httpError('Google Drive access was revoked or expired. Reconnect Google Drive.', 400);
    throw httpError(`Google sign-in failed (${json.error || `HTTP ${res.status}`})`, res.status);
  }
  return json;
}

// Code from the OAuth callback -> { refreshToken, scope }
export async function exchangeCode(code) {
  const t = await tokenRequest({
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });
  if (!t.refresh_token)
    throw new Error(
      'Google did not return a refresh token. Remove Mojobase from your Google account permissions and connect again.'
    );
  if (t.scope && !t.scope.split(' ').includes(DRIVE_SCOPE))
    throw new Error('Google Drive permission was not granted.');
  return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in };
}

export class DriveClient {
  constructor({ refreshToken, accessToken, expiresIn }) {
    this.refreshToken = refreshToken;
    this.accessToken = accessToken || null;
    this.expiresAt = accessToken ? Date.now() + (expiresIn || 3000) * 1000 - 60_000 : 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const t = await tokenRequest({ refresh_token: this.refreshToken, grant_type: 'refresh_token' });
    this.accessToken = t.access_token;
    this.expiresAt = Date.now() + (t.expires_in || 3600) * 1000 - 60_000;
    return this.accessToken;
  }

  async api(method, path, { query, json, okStatus = [200], headers = {}, body } = {}) {
    const url = new URL(path, config.googleDrive.apiUrl);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const payload = json ? JSON.stringify(json) : body;
    const res = await request({
      method,
      url,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        ...(json ? { 'content-type': 'application/json; charset=UTF-8' } : {}),
        ...(payload !== undefined ? { 'content-length': String(Buffer.byteLength(payload)) } : {}),
        ...headers,
      },
      body: payload,
      timeoutMs: 120_000,
    });
    if (res.status === 401) this.accessToken = null;
    if (!okStatus.includes(res.status)) {
      let reason = '';
      try {
        reason = JSON.parse(res.body.toString('utf8')).error?.message || '';
      } catch {
        /* not JSON */
      }
      throw httpError(
        `Google Drive returned ${res.status}${reason ? `: ${reason.slice(0, 200)}` : ''}`,
        res.status
      );
    }
    return res;
  }

  async listChildren(parentId, { foldersOnly = false } = {}) {
    const files = [];
    let pageToken = null;
    const q = [`'${parentId.replace(/'/g, '')}' in parents`, 'trashed = false'];
    if (foldersOnly) q.push(`mimeType = '${FOLDER}'`);
    for (let i = 0; i < 100; i++) {
      const query = {
        q: q.join(' and '),
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: '1000',
        spaces: 'drive',
      };
      if (pageToken) query.pageToken = pageToken;
      const res = await withRetry(() => this.api('GET', '/drive/v3/files', { query }));
      const json = JSON.parse(res.body.toString('utf8'));
      files.push(...(json.files || []));
      pageToken = json.nextPageToken;
      if (!pageToken) break;
    }
    return files;
  }

  // Folders the app created in My Drive's top level with this name.
  async findRootFolder(name) {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const res = await withRetry(() =>
      this.api('GET', '/drive/v3/files', {
        query: {
          q: `name = '${esc}' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`,
          fields: 'files(id, name)',
          spaces: 'drive',
        },
      })
    );
    return JSON.parse(res.body.toString('utf8')).files?.[0] || null;
  }

  async createFolder(name, parentId) {
    const res = await withRetry(() =>
      this.api('POST', '/drive/v3/files', {
        query: { fields: 'id, name' },
        json: { name, mimeType: FOLDER, ...(parentId ? { parents: [parentId] } : {}) },
      })
    );
    return JSON.parse(res.body.toString('utf8'));
  }

  async ensureRootFolder(name) {
    return (await this.findRootFolder(name)) || this.createFolder(name);
  }

  async ensureChildFolder(parentId, name) {
    const existing = (await this.listChildren(parentId, { foldersOnly: true })).find(
      (f) => f.name === name
    );
    return existing || this.createFolder(name, parentId);
  }

  remove(id) {
    return withRetry(() =>
      this.api('DELETE', `/drive/v3/files/${encodeURIComponent(id)}`, { okStatus: [200, 204, 404] })
    );
  }

  // Resumable upload of a local file (or a Buffer) into parentId.
  async upload(name, parentId, { file, buffer, size, contentType = 'application/octet-stream' }) {
    const init = await withRetry(() =>
      this.api('POST', '/upload/drive/v3/files', {
        query: { uploadType: 'resumable', fields: 'id' },
        json: { name, parents: [parentId] },
        headers: { 'x-upload-content-type': contentType, 'x-upload-content-length': String(size) },
      })
    );
    const session = init.headers.location;
    if (!session) throw new Error('Google Drive did not return an upload session');
    const fh = file ? await fs.promises.open(file, 'r') : null;
    try {
      let offset = 0;
      for (let guard = 0; guard < 1_000_000; guard++) {
        const len = Math.min(chunkSize, size - offset);
        let buf = Buffer.alloc(0);
        if (len > 0) {
          if (fh) {
            buf = Buffer.allocUnsafe(len);
            const { bytesRead } = await fh.read(buf, 0, len, offset);
            if (bytesRead !== len) throw new Error('File changed while uploading');
          } else buf = buffer.subarray(offset, offset + len);
        }
        const range = size === 0 ? 'bytes */0' : `bytes ${offset}-${offset + len - 1}/${size}`;
        const res = await withRetry(async () => {
          const r = await request({
            method: 'PUT',
            url: session,
            headers: {
              authorization: `Bearer ${await this.token()}`,
              'content-length': String(len),
              'content-range': range,
            },
            body: buf,
            timeoutMs: 10 * 60_000,
          });
          if (r.status >= 500 || r.status === 429)
            throw httpError(`Google Drive upload returned ${r.status}`, r.status);
          return r;
        });
        if (res.status === 200 || res.status === 201) return JSON.parse(res.body.toString('utf8'));
        if (res.status !== 308)
          throw httpError(`Google Drive upload returned ${res.status}`, res.status);
        // Range: bytes=0-N tells us how much Google has; continue from there.
        const m = /bytes=0-(\d+)/.exec(res.headers.range || '');
        offset = m ? Number(m[1]) + 1 : 0;
        if (offset >= size && size > 0) throw new Error('Google Drive did not finish the upload');
      }
      throw new Error('Upload did not finish');
    } finally {
      await fh?.close();
    }
  }
}

// Destination adapter used by the backup runner.
export function driveDestination(cfg) {
  const client = new DriveClient({ refreshToken: cfg.refreshToken });
  const rootName = cfg.folderName || 'Mojobase Backups';
  const projectFolder = async (ref, create, folderName) => {
    const root = await client.ensureRootFolder(rootName);
    const children = await client.listChildren(root.id, { foldersOnly: true });
    const found = children.find((f) => f.name.endsWith(`-${ref}`) || f.name === ref);
    if (found || !create) return found || null;
    return client.createFolder(folderName, root.id);
  };
  return {
    client,
    // where: { ref, projectFolder: '<name>-<ref>', stamp }
    async upload(where, artifacts, manifest) {
      const { ref, stamp } = where;
      const pf = await projectFolder(ref, true, where.projectFolder);
      const run = await client.ensureChildFolder(pf.id, stamp);
      let bytes = 0;
      for (const a of artifacts) {
        await client.upload(a.name, run.id, { file: a.path, size: a.size });
        bytes += a.size;
      }
      const buf = Buffer.from(JSON.stringify(manifest, null, 2));
      await client.upload('manifest.json', run.id, {
        buffer: buf,
        size: buf.length,
        contentType: 'application/json',
      });
      return { bytes: bytes + buf.length };
    },
    async listRuns(ref) {
      const pf = await projectFolder(ref, false);
      if (!pf) return [];
      return (await client.listChildren(pf.id, { foldersOnly: true })).map((f) => ({
        id: f.id,
        stamp: f.name,
      }));
    },
    // Deleting a folder the app created deletes everything in it.
    removeRun: (run) => client.remove(run.id),
    async test() {
      const root = await client.ensureRootFolder(rootName);
      const buf = Buffer.from('Mojobase connection test\n');
      const f = await client.upload('.mojobase-connection-test', root.id, {
        buffer: buf,
        size: buf.length,
        contentType: 'text/plain',
      });
      await client.remove(f.id);
    },
  };
}
