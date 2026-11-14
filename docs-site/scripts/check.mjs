#!/usr/bin/env node
// Verify the built site in console/public/docs:
//  1. every internal /docs/... link and /docs/assets/... reference resolves to a file
//  2. list every remaining "insforge" (any case) in the rendered text of each page
//  3. no inline <script>, inline event handlers, or external scripts/styles/images
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'console',
  'public',
  'docs'
);
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else files.push(p);
  }
})(OUT);
const html = files.filter((f) => f.endsWith('.html'));

function resolves(url) {
  const clean = url.split('#')[0].split('?')[0];
  if (!clean.startsWith('/docs')) return true;
  const rel = clean.replace(/^\/docs\/?/, '');
  const p = path.join(OUT, rel);
  if (/\.html$/.test(clean)) return false; // no .html URLs allowed
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return true;
  return fs.existsSync(path.join(p, 'index.html'));
}

let refs = 0;
const broken = [];
const insforge = [];
const csp = [];
const anchorsMissing = [];
const idsByPage = new Map();
for (const f of html) {
  const s = fs.readFileSync(f, 'utf8');
  idsByPage.set(f, new Set([...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}
for (const f of html) {
  const s = fs.readFileSync(f, 'utf8');
  const page = '/' + path.relative(path.dirname(OUT), f).replace(/index\.html$/, '');
  for (const m of s.matchAll(/\s(?:href|src|srcset)="([^"]+)"/g)) {
    const url = m[1].replace(/&amp;/g, '&');
    if (/^(https?:|mailto:|#)/.test(url)) {
      if (url.startsWith('#') && !idsByPage.get(f).has(decodeURIComponent(url.slice(1))))
        anchorsMissing.push(`${page} -> ${url}`);
      continue;
    }
    refs++;
    if (!url.startsWith('/docs')) {
      broken.push(`${page} -> ${url} (not under /docs)`);
      continue;
    }
    if (!resolves(url)) broken.push(`${page} -> ${url}`);
    const hash = url.split('#')[1];
    if (hash && resolves(url)) {
      const target = path.join(OUT, url.split('#')[0].replace(/^\/docs\/?/, ''), 'index.html');
      if (idsByPage.has(target) && !idsByPage.get(target).has(hash))
        anchorsMissing.push(`${page} -> ${url}`);
    }
  }
  if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(s)) csp.push(`${page}: inline <script>`);
  if (
    /\son[a-z]+\s*=/i.test(
      s.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code[\s\S]*?<\/code>/g, '')
    )
  )
    csp.push(`${page}: inline event handler`);
  for (const m of s.matchAll(
    /<(?:script|link|img|source)\b[^>]*\s(?:src|href|srcset)="(https?:[^"]+)"/g
  ))
    csp.push(`${page}: external resource ${m[1]}`);
  // rendered text: drop tags (attributes included), decode entities
  const text = s
    .replace(
      /<head>[\s\S]*?<\/head>/,
      (h) =>
        (h.match(/<title>[\s\S]*?<\/title>/) || [''])[0] +
        ' ' +
        (h.match(/<meta name="description" content="([^"]*)"/) || ['', ''])[1]
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  for (const m of text.matchAll(/[^\s]{0,40}insforge[^\s]{0,40}/gi))
    insforge.push({ page, hit: m[0] });
  // attribute values that are visible URLs (href) too
  for (const m of s.matchAll(/href="([^"]*insforge[^"]*)"/gi))
    insforge.push({ page, hit: 'href=' + m[1] });
}
const search = JSON.parse(fs.readFileSync(path.join(OUT, 'search-index.json'), 'utf8'));
for (const p of search) if (!resolves(p.u)) broken.push(`search-index -> ${p.u}`);
const searchHits = JSON.stringify(search).match(/[^\s"]{0,30}insforge[^\s"]{0,30}/gi) || [];

console.log(`HTML pages: ${html.length}`);
console.log(`Internal /docs references checked: ${refs}; broken: ${broken.length}`);
broken.forEach((b) => console.log('  BROKEN ' + b));
console.log(`Missing in-page anchors: ${anchorsMissing.length}`);
anchorsMissing.slice(0, 50).forEach((b) => console.log('  ANCHOR ' + b));
console.log(`CSP issues: ${csp.length}`);
csp.forEach((b) => console.log('  CSP ' + b));
const grouped = {};
for (const { page, hit } of insforge) (grouped[hit] ||= new Set()).add(page);
console.log(
  `"insforge" occurrences in rendered text: ${insforge.length} (${Object.keys(grouped).length} distinct)`
);
for (const [hit, pages] of Object.entries(grouped).sort())
  console.log(
    `  ${JSON.stringify(hit)}  x${[...pages].length} pages  e.g. ${[...pages].slice(0, 2).join(', ')}`
  );
console.log(`"insforge" in search-index.json: ${searchHits.length}`);
[...new Set(searchHits)].forEach((h) => console.log('  ' + h));
process.exitCode = broken.length || csp.length ? 1 : 0;
