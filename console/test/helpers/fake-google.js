// Fake Google OAuth token endpoint + Drive v3 API (files, resumable uploads)
// for tests. Serves /token, /drive/v3/..., /upload/drive/v3/... on one port.
import http from 'node:http';
import crypto from 'node:crypto';

const FOLDER = 'application/vnd.google-apps.folder';

export async function fakeGoogle({
  clientId = 'cid.apps.googleusercontent.com',
  clientSecret = 'csecret',
} = {}) {
  const files = new Map(); // id -> { id, name, mimeType, parents, body }
  const sessions = new Map(); // upload session id -> { meta, size, received: Buffer[] }
  const state = {
    files,
    codes: new Map([['good-code', 'refresh-1']]), // auth code -> refresh token
    refreshTokens: new Set(['refresh-1']),
    accessTokens: new Set(),
    tokenRequests: [],
    failUploads: false,
    failChunks: 0, // answer this many chunk PUTs with 502 without storing them
    storeThenFail: 0, // store this many chunks but still answer 502
    expireSessions: 0, // answer this many chunk PUTs with 404 (session gone)
    chunkRequests: 0,
  };
  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(obj));
  };
  const childrenOf = (id) => [...files.values()].filter((f) => f.parents.includes(id));
  const removeTree = (id) => {
    for (const c of childrenOf(id)) removeTree(c.id);
    files.delete(id);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/token' && req.method === 'POST') {
        const p = new URLSearchParams(body.toString());
        state.tokenRequests.push(Object.fromEntries(p));
        if (p.get('client_id') !== clientId || p.get('client_secret') !== clientSecret)
          return json(res, 401, { error: 'invalid_client' });
        const access = `ya29.${crypto.randomBytes(8).toString('hex')}`;
        if (p.get('grant_type') === 'authorization_code') {
          const refresh = state.codes.get(p.get('code'));
          if (!refresh) return json(res, 400, { error: 'invalid_grant' });
          state.codes.delete(p.get('code'));
          state.accessTokens.add(access);
          return json(res, 200, {
            access_token: access,
            expires_in: 3599,
            refresh_token: refresh,
            scope: 'https://www.googleapis.com/auth/drive.file',
            token_type: 'Bearer',
          });
        }
        if (p.get('grant_type') === 'refresh_token') {
          if (!state.refreshTokens.has(p.get('refresh_token')))
            return json(res, 400, { error: 'invalid_grant' });
          state.accessTokens.add(access);
          return json(res, 200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!state.accessTokens.has(token))
        return json(res, 401, { error: { message: 'Invalid Credentials' } });

      if (url.pathname === '/drive/v3/about')
        return json(res, 200, { user: { emailAddress: 'owner@gmail.example' } });
      if (url.pathname === '/drive/v3/files' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        let list = [...files.values()];
        const parent = /'([^']+)' in parents/.exec(q);
        if (parent) list = list.filter((f) => f.parents.includes(parent[1]));
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q);
        if (name) list = list.filter((f) => f.name === name[1].replace(/\\(.)/g, '$1'));
        if (q.includes(`mimeType = '${FOLDER}'`)) list = list.filter((f) => f.mimeType === FOLDER);
        return json(res, 200, {
          files: list.map(({ id, name: n, mimeType }) => ({ id, name: n, mimeType })),
        });
      }
      if (url.pathname === '/drive/v3/files' && req.method === 'POST') {
        const meta = JSON.parse(body.toString());
        const f = {
          id: crypto.randomUUID(),
          name: meta.name,
          mimeType: meta.mimeType,
          parents: meta.parents || ['root'],
        };
        files.set(f.id, f);
        return json(res, 200, { id: f.id, name: f.name });
      }
      const del = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if (del && req.method === 'DELETE') {
        if (!files.has(del[1])) return json(res, 404, { error: { message: 'File not found' } });
        removeTree(del[1]);
        res.writeHead(204);
        return res.end();
      }
      if (
        url.pathname === '/upload/drive/v3/files' &&
        req.method === 'POST' &&
        url.searchParams.get('uploadType') === 'resumable'
      ) {
        const id = crypto.randomUUID();
        sessions.set(id, {
          meta: JSON.parse(body.toString()),
          size: Number(req.headers['x-upload-content-length']),
          received: [],
        });
        res.writeHead(200, { location: `http://${req.headers.host}/upload/session/${id}` });
        return res.end();
      }
      const sess = /^\/upload\/session\/([^/]+)$/.exec(url.pathname);
      if (sess && req.method === 'PUT') {
        state.chunkRequests++;
        const s = sessions.get(sess[1]);
        if (!s) return json(res, 404, { error: { message: 'No session' } });
        if (state.failUploads)
          return json(res, 403, {
            error: { message: 'The user has exceeded their Drive storage quota' },
          });
        if (state.expireSessions > 0) {
          state.expireSessions--;
          sessions.delete(sess[1]);
          return json(res, 404, { error: { message: 'No session' } });
        }
        if (state.failChunks > 0 && body.length) {
          state.failChunks--;
          return json(res, 502, { error: { message: 'Bad Gateway' } });
        }
        const range = req.headers['content-range'];
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range || '');
        const have = s.received.reduce((n, b) => n + b.length, 0);
        if (m && Number(m[1]) !== have) return json(res, 400, { error: { message: 'bad offset' } });
        if (body.length) s.received.push(body);
        const total = have + body.length;
        if (state.storeThenFail > 0 && body.length) {
          state.storeThenFail--;
          return json(res, 502, { error: { message: 'Bad Gateway' } });
        }
        if (total < s.size) {
          res.writeHead(308, total ? { range: `bytes=0-${total - 1}` } : {});
          return res.end();
        }
        const f = {
          id: crypto.randomUUID(),
          name: s.meta.name,
          mimeType: 'application/octet-stream',
          parents: s.meta.parents,
          body: Buffer.concat(s.received),
        };
        files.set(f.id, f);
        sessions.delete(sess[1]);
        return json(res, 200, { id: f.id });
      }
      json(res, 404, { error: { message: `not found ${req.method} ${url.pathname}` } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Path of names from My Drive's root, e.g. "Mojobase Backups/app-ref/2026-01-01T0300Z/database.dump"
  const pathOf = (f) => {
    const names = [f.name];
    let p = f.parents[0];
    while (p && p !== 'root') {
      const parent = files.get(p);
      if (!parent) break;
      names.unshift(parent.name);
      p = parent.parents[0];
    }
    return names.join('/');
  };
  return {
    state,
    base,
    env: {
      GOOGLE_DRIVE_CLIENT_ID: clientId,
      GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
      GOOGLE_OAUTH_AUTH_URL: `${base}/auth`,
      GOOGLE_OAUTH_TOKEN_URL: `${base}/token`,
      GOOGLE_DRIVE_API_URL: base,
    },
    paths: () => [...files.values()].map(pathOf).sort(),
    fileAt: (p) => [...files.values()].find((f) => pathOf(f) === p),
    mkdirs: (p) => {
      let parent = 'root';
      for (const name of p.split('/')) {
        let f = [...files.values()].find((x) => x.name === name && x.parents.includes(parent));
        if (!f) {
          f = { id: crypto.randomUUID(), name, mimeType: FOLDER, parents: [parent] };
          files.set(f.id, f);
        }
        parent = f.id;
      }
      return parent;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
