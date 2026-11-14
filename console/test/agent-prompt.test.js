// The AI agent prompt must carry every credential and every integration step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

Object.assign(process.env, {
  CONSOLE_SECRET: 'y'.repeat(64),
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mbprompt-')),
  PROJECT_APP_IMAGE: 'a',
  PROJECT_POSTGRES_IMAGE: 'b',
  PROJECT_DENO_IMAGE: 'c',
});
const { agentPrompt } = await import('../src/agent-prompt.js');
const { newSecrets } = await import('../src/project-stack.js');

test('agent prompt includes all keys, the connection string and every section', () => {
  const secrets = newSecrets();
  const prompt = agentPrompt({
    ref: 'abcdefgh12345678',
    name: 'shop',
    status: 'ready',
    db_port: 15411,
    created_at: '2026-01-01',
    secrets,
  });
  for (const value of [
    'https://abcdefgh12345678.mojobase.dev',
    secrets.anonKey,
    secrets.apiKey,
    secrets.dbPassword,
    `postgresql://mojobase:${secrets.dbPassword}@db.mojobase.dev:15411/insforge?sslmode=require`,
    'npm install @insforge/sdk',
    'ENABLE ROW LEVEL SECURITY',
    'auth.signInWithPassword',
    "storage.from('avatars').upload",
    '/api/functions',
    'realtime.channels',
    'https://mojobase.dev/mcp',
  ])
    assert.ok(prompt.includes(value), `prompt is missing ${value.slice(0, 40)}`);
  // Never leak the superuser password or internal secrets.
  for (const secret of [secrets.postgresPassword, secrets.jwtSecret, secrets.encryptionKey])
    assert.ok(!prompt.includes(secret));
});
