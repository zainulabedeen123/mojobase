// Minimal HTTP(S) client for offsite backup destinations (node:http/https, no
// dependencies). Bodies can be a Buffer/string or a readable stream, so large
// uploads are never held in memory. Redirects are never followed.
//
// SSRF guard: a request with `guard: true` (S3 endpoints, which users type in)
// only goes to public addresses. Every DNS answer is checked at connect time, so
// a hostname cannot pass validation and later resolve to a private address.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { config } from '../config.js';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
])
  blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
])
  blocked.addSubnet(addr, bits, 'ipv6');

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:XXXX:YYYY): judge the IPv4 address.
    const a = address.toLowerCase();
    const dotted = a.match(/^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return blocked.check(dotted[1], 'ipv4');
    const hex = a.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

export class EndpointError extends Error {}

// Static checks on a user-supplied endpoint URL. Returns the normalized URL.
export function validateEndpoint(raw, { allowPrivate = config.allowPrivateS3Endpoints } = {}) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointError('Endpoint must be a URL like https://s3.example.com');
  }
  if (url.username || url.password)
    throw new EndpointError('Endpoint must not contain credentials');
  if (url.search || url.hash) throw new EndpointError('Endpoint must not have a query string');
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:'))
    throw new EndpointError('Endpoint must use https://');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (net.isIP(host) && isPrivateAddress(host))
      throw new EndpointError('Endpoint must be a public address');
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) || !host.includes('.'))
      throw new EndpointError('Endpoint must be a public host name');
  }
  return url;
}

// dns.lookup replacement that refuses private answers.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad || !addresses.length)
      return callback(
        Object.assign(new EndpointError(`Endpoint resolves to a private address`), {
          code: 'EPRIVATE',
        })
      );
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * request({ method, url, headers, body, guard, timeoutMs }) ->
 *   { status, headers, body: Buffer }
 * body: Buffer | string | Readable | undefined
 */
export function request({
  method = 'GET',
  url,
  headers = {},
  body,
  guard = false,
  timeoutMs = 120_000,
}) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const allowPrivate = config.allowPrivateS3Endpoints;
  if (guard && !allowPrivate) {
    if (u.protocol !== 'https:')
      return Promise.reject(new EndpointError('Endpoint must use https://'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host))
      return Promise.reject(new EndpointError('Endpoint must be a public address'));
  }
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method,
        headers,
        lookup: guard && !allowPrivate ? guardedLookup : undefined,
        // Never reuse a keep-alive socket opened under a different guard decision.
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          // Responses we care about are small (XML / JSON); cap what we keep.
          if (size < 4 * 1024 * 1024) chunks.push(c);
          size += c.length;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    if (body === undefined || body === null) req.end();
    else if (typeof body === 'string' || Buffer.isBuffer(body)) req.end(body);
    else {
      body.on('error', (e) => req.destroy(e));
      body.pipe(req);
    }
  });
}

// Retries transient failures (network errors, 5xx, 429) a few times.
export async function withRetry(fn, { attempts = 3, delayMs = retryDelayMs } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      last = e;
      if (e instanceof EndpointError || e.permanent || i === attempts) throw e;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw last;
}
let retryDelayMs = 1000;
export const _setRetryDelay = (ms) => (retryDelayMs = ms);

// Error for an HTTP response: 4xx (other than 408/429) are not worth retrying.
export function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  e.permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
  return e;
}
