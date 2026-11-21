// AWS Signature Version 4 (header-based) with node:crypto only.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import crypto from 'node:crypto';

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

// RFC 3986 encoding: everything except A-Z a-z 0-9 - _ . ~ is percent-encoded.
export function uriEncode(str, { keepSlash = false } = {}) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    if (/[A-Za-z0-9\-_.~]/.test(c) || (keepSlash && c === '/')) out += c;
    else out += `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// S3 does not normalize paths: each segment is encoded once, slashes kept.
export const canonicalUri = (path) => uriEncode(path || '/', { keepSlash: true });

// query: array of [key, value] pairs (or an object).
export function canonicalQuery(query = []) {
  const pairs = Array.isArray(query) ? query : Object.entries(query);
  return pairs
    .map(([k, v]) => [uriEncode(k), uriEncode(v ?? '')])
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

const trimAll = (v) => String(v).trim().replace(/\s+/g, ' ');

export function signingKey(secret, date, region, service) {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Signs a request. Returns the headers to send (input headers plus
 * x-amz-date, x-amz-content-sha256 for s3, and Authorization) and the
 * intermediate strings (handy for tests).
 *
 * { method, path, query, headers, payloadHash, accessKeyId, secretAccessKey,
 *   region, service = 's3', date = new Date(), addContentSha = service === 's3' }
 */
export function sign({
  method,
  path,
  query = [],
  headers = {},
  payloadHash = EMPTY_SHA256,
  accessKeyId,
  secretAccessKey,
  region,
  service = 's3',
  date = new Date(),
  addContentSha = service === 's3',
}) {
  const amzDate = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const day = amzDate.slice(0, 8);
  const out = { ...headers };
  const lower = Object.fromEntries(Object.entries(out).map(([k, v]) => [k.toLowerCase(), v]));
  if (!('x-amz-date' in lower)) out['x-amz-date'] = amzDate;
  if (addContentSha && !('x-amz-content-sha256' in lower))
    out['x-amz-content-sha256'] = payloadHash;

  const canon = {};
  for (const [k, v] of Object.entries(out)) {
    const name = k.toLowerCase();
    if (name === 'authorization' || name === 'content-length' || name === 'user-agent') continue;
    canon[name] = canon[name] === undefined ? trimAll(v) : `${canon[name]},${trimAll(v)}`;
  }
  const names = Object.keys(canon).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(path),
    canonicalQuery(query),
    names.map((n) => `${n}:${canon[n]}\n`).join(''),
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, day, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, canonicalRequest, stringToSign, signature };
}
