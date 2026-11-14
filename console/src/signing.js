// The console signs short-lived "project authorization" tokens (RS256 JWTs)
// that a project's embedded dashboard exchanges for an admin session, exactly
// like InsForge Cloud does. Each project verifies them against the public key
// served at <internal console>/.well-known/jwks.json (CLOUD_API_HOST).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const keyFile = path.join(config.dataDir, 'signing-key.pem');

function loadOrCreateKey() {
  if (fs.existsSync(keyFile)) return crypto.createPrivateKey(fs.readFileSync(keyFile));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return privateKey;
}

const privateKey = loadOrCreateKey();
const publicJwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
const kid = crypto
  .createHash('sha256')
  .update(JSON.stringify(publicJwk))
  .digest('base64url')
  .slice(0, 16);

export const jwks = { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function signProjectAuthorization({ userId, projectRef, ttlSeconds = 120 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: 'RS256', typ: 'JWT', kid });
  const payload = b64({
    type: 'project_authorization',
    userId,
    projectId: projectRef,
    iss: config.consoleOrigin,
    iat: now,
    exp: now + ttlSeconds,
  });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}
