// Environment for tests that import console modules in-process. Import first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mboffsite-'));
Object.assign(process.env, {
  CONSOLE_SECRET: 'y'.repeat(64),
  DATA_DIR: path.join(tmp, 'data'),
  PROJECT_APP_IMAGE: 'ghcr.io/example/mojobase:test',
  PROJECT_POSTGRES_IMAGE: 'ghcr.io/example/mojobase-postgres:test',
  PROJECT_DENO_IMAGE: 'ghcr.io/example/mojobase-deno:test',
  CONSOLE_ORIGIN: 'http://localhost:39200',
  COMPOSE_ROOT: path.join(tmp, 'docker'),
  RESEND_API_KEY: '',
});
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
