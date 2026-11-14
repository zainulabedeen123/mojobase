#!/usr/bin/env node
// Build the static Mojobase docs site into console/public/docs/.
//
//   cd docs-site && npm install && npm run build
//
// Source: ../docs (English Mintlify MDX + docs.json), with Mojobase-specific
// pages from ./content/pages and patches from ./content/config.mjs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { createRenderer, escapeHtml, slugify } from './lib/mdx.mjs';
import { rebrand, mapUrl, MOJOBASE_REPO, CONSOLE } from './lib/rebrand.mjs';
import {
  EXCLUDED,
  OVERRIDES,
  NAV_INSERT,
  NAV_RENAME,
  GLOBAL_PATCHES,
  PATCHES,
} from './content/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(ROOT, 'console', 'public', 'docs');
const PAGES_DIR = path.join(HERE, 'content', 'pages');
const IMG_OVERRIDES = path.join(HERE, 'images');
const BASE = '/docs';

const warnings = [];
const warn = (m) => warnings.push(m);

// ------------------------------------------------------------------ nav

const docsJson = JSON.parse(fs.readFileSync(path.join(DOCS, 'docs.json'), 'utf8'));
const en = docsJson.navigation.languages.find((l) => l.language === 'en');
const redirects = Object.fromEntries(
  (docsJson.redirects || []).map((r) => [
    r.source.replace(/^\//, ''),
    r.destination.replace(/^\//, ''),
  ])
);

function filterNav(items) {
  const out = [];
  for (const it of items) {
    if (typeof it === 'string') {
      if (EXCLUDED[it]) continue;
      out.push(it);
      for (const [after, add] of NAV_INSERT) if (after === it) out.push(add);
    } else {
      if (it.openapi) continue; // API reference groups point at remote specs
      if (it.group in NAV_RENAME && NAV_RENAME[it.group] === null) continue;
      const pages = filterNav([...(it.pages || [])]);
      if (it.root && !EXCLUDED[it.root]) pages.unshift(it.root);
      if (!pages.length) continue;
      out.push({ group: it.group, expanded: !!it.expanded, pages });
    }
  }
  return out;
}

const tabs = en.tabs
  .map((t) => ({ tab: t.tab, groups: filterNav(t.groups || []) }))
  .filter((t) => t.groups.length);

// Flatten in reading order, remembering each page's group trail.
const order = [];
const groupOf = {};
function walk(items, trail) {
  for (const it of items) {
    if (typeof it === 'string') {
      order.push(it);
      groupOf[it] = trail;
    } else walk(it.pages, [...trail, it.group]);
  }
}
for (const t of tabs) for (const g of t.groups) walk([g], [t.tab]);
const kept = new Set(order);

const linkOf = (slug) => (slug === 'introduction' ? BASE : `${BASE}/${slug}`);

// ------------------------------------------------------------------ sources

function readSource(slug) {
  const override = path.join(PAGES_DIR, slug + '.mdx');
  if (OVERRIDES.includes(slug) && fs.existsSync(override)) return fs.readFileSync(override, 'utf8');
  const p = path.join(DOCS, slug + '.mdx');
  if (!fs.existsSync(p)) throw new Error(`Missing source for ${slug}`);
  return fs.readFileSync(p, 'utf8');
}

function splitFrontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return { fm: {}, body: src };
  return { fm: yaml.load(m[1]) || {}, body: src.slice(m[0].length) };
}

function stripImportsExports(body) {
  const imports = {};
  // only top-level import lines (outside code fences)
  const lines = body.split('\n');
  const out = [];
  let fence = null;
  let skippingExport = false;
  for (const line of lines) {
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      out.push(line);
      if (fm && fm[1][0] === fence[0] && line.trim().replace(/[`~]/g, '') === '') fence = null;
      continue;
    }
    if (fm) {
      fence = fm[1];
      out.push(line);
      continue;
    }
    if (skippingExport) {
      if (/^};?\s*$/.test(line)) skippingExport = false;
      continue;
    }
    const im =
      /^import\s+(?:\{\s*(\w+)\s*\}|(\w+))\s+from\s+['"](\/snippets\/[^'"]+)['"];?\s*$/.exec(line);
    if (im) {
      imports[im[1] || im[2]] = im[3];
      continue;
    }
    if (/^import\s.+from\s+['"].+['"];?\s*$/.test(line)) continue;
    if (/^export\s+const\s/.test(line)) {
      skippingExport = !/;\s*$/.test(line);
      continue;
    }
    out.push(line);
  }
  return { body: out.join('\n'), imports };
}

function inlineSnippets(body, imports, depth = 0) {
  for (const [name, file] of Object.entries(imports)) {
    const re = new RegExp(`<${name}\\b[^>]*/>`, 'g');
    if (!re.test(body)) continue;
    const snippetSrc = fs.readFileSync(path.join(DOCS, file.replace(/^\//, '')), 'utf8');
    const { body: sb, imports: si } = stripImportsExports(splitFrontmatter(snippetSrc).body);
    const content = depth < 3 ? inlineSnippets(sb, si, depth + 1) : sb;
    body = body.replace(new RegExp(`<${name}\\b[^>]*/>`, 'g'), () => '\n' + content.trim() + '\n');
  }
  return body;
}

const patchHits = new Map();
let fmRef = {};
function applyPatches(slug, text) {
  for (const [find, repl] of GLOBAL_PATCHES) {
    text = text.replace(find, repl);
    if (fmRef.description) fmRef.description = String(fmRef.description).replace(find, repl);
  }
  for (const [find, repl] of PATCHES[slug] || []) {
    if (typeof find === 'string' && fmRef.description && fmRef.description.includes(find)) {
      fmRef.description = fmRef.description.split(find).join(repl);
      continue;
    }
    const key = `${slug} :: ${String(find).slice(0, 60)}`;
    const before = text;
    text = typeof find === 'string' ? text.split(find).join(repl) : text.replace(find, repl);
    if (before === text) warn(`patch did not apply: ${key}`);
    patchHits.set(key, before !== text);
  }
  return text;
}

const NATIVE_NOTE = (lang) =>
  `<Note>\n  Mojobase is compatible with the open-source InsForge ${lang} SDK. Mojobase does not publish its own ${lang} package, so install the InsForge one as shown and point it at your Mojobase project URL (\`https://your-project.mojobase.dev\`) and the anon key from the project's **Connect** panel.\n</Note>\n\n`;

// ------------------------------------------------------------------ assets

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets', 'images'), { recursive: true });

const copiedImages = new Map();
function resolveImage(src) {
  if (!src) return null;
  if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) {
    warn(`dropped external image ${src}`);
    return null;
  }
  let rel = src
    .replace(/^\/docs\//, '/')
    .replace(/^\//, '')
    .split(/[?#]/)[0];
  try {
    rel = decodeURIComponent(rel);
  } catch {
    // keep the raw path when it is not valid URI encoding
  }
  if (!rel.startsWith('images/') && !rel.startsWith('logo/')) {
    warn(`unknown image path ${src}`);
    return null;
  }
  if (copiedImages.has(rel)) return copiedImages.get(rel);
  const override = path.join(IMG_OVERRIDES, rel.replace(/^images\//, ''));
  const file = fs.existsSync(override) ? override : path.join(DOCS, rel);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    warn(`missing image ${src}`);
    return null;
  }
  if (/\.(mp4|mov|webm)$/i.test(file)) return null;
  const outRel = rel.replace(/^images\//, '').replace(/insforge/gi, 'mojobase');
  const dest = path.join(OUT, 'assets', 'images', outRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  const url = `${BASE}/assets/images/${outRel}`;
  copiedImages.set(rel, url);
  return url;
}

function resolveHref(href) {
  if (!href) return null;
  href = String(href).trim();
  if (href.startsWith('#') || href.startsWith('mailto:')) return href;
  if (/^https?:\/\//i.test(href)) {
    const mapped = mapUrl(href);
    if (mapped === null) return null;
    if (mapped.startsWith('/')) return resolveHref(mapped);
    return mapped;
  }
  if (!href.startsWith('/')) {
    warn(`relative link ${href}`);
    return null;
  }
  const [p, hash = ''] = href.split('#');
  let slug = p.replace(/^\/docs(?=\/|$)/, '').replace(/^\/+|\/+$/g, '');
  if (redirects[slug]) slug = redirects[slug];
  const h = hash ? '#' + hash : '';
  if (slug === '' || slug === 'introduction') return BASE + h;
  if (kept.has(slug)) return `${BASE}/${slug}${h}`;
  if (EXCLUDED[slug] || /^(agent-native|deployment|showcase)\//.test(slug)) return null;
  warn(`link to unknown page ${href}`);
  return null;
}

// ------------------------------------------------------------------ pages

const pages = [];
for (const slug of order) {
  const raw = readSource(slug);
  const { fm, body: rawBody } = splitFrontmatter(raw);
  let { body, imports } = stripImportsExports(rawBody);
  body = inlineSnippets(body, imports);
  fmRef = fm;
  body = applyPatches(slug, body);
  const cliLeft = body.match(/@insforge\/cli|\binsforge (?:db|secrets|link|login)\b|npx insforge/g);
  if (cliLeft) warn(`CLI reference left in ${slug}: ${[...new Set(cliLeft)].join(', ')}`);
  const title = rebrand(String(fm.title || slug));
  const navTitle = rebrand(String(fm.sidebarTitle || fm.title || slug)).replace(
    / · Recommended$/,
    ''
  );
  const description = rebrand(String(fm.description || ''));
  body = rebrand(body);
  // added after rebranding on purpose: these name the real InsForge native SDKs
  if (/^sdks\/swift\//.test(slug)) body = NATIVE_NOTE('Swift') + body;
  if (/^sdks\/kotlin\//.test(slug)) body = NATIVE_NOTE('Kotlin') + body;
  pages.push({ slug, title, navTitle, description, body });
}
const bySlug = Object.fromEntries(pages.map((p) => [p.slug, p]));

// Render after all titles are known.
for (const page of pages) {
  const toc = [];
  const used = new Map();
  const renderer = createRenderer({
    resolveHref,
    resolveImage,
    onHeading(text, depth, collect) {
      let id = slugify(text);
      const n = used.get(id) || 0;
      used.set(id, n + 1);
      if (n) id = `${id}-${n}`;
      if (collect && (depth === 2 || depth === 3)) toc.push({ id, text, depth });
      return id;
    },
  });
  page.html = renderer.render(page.body);
  page.toc = toc;
}

// ------------------------------------------------------------------ chrome

const css = fs.readFileSync(path.join(HERE, 'assets', 'docs.css'), 'utf8');
const js = fs.readFileSync(path.join(HERE, 'assets', 'docs.js'), 'utf8');
const ver = crypto
  .createHash('sha1')
  .update(css + js)
  .digest('hex')
  .slice(0, 10);
fs.writeFileSync(path.join(OUT, 'assets', 'docs.css'), css);
fs.writeFileSync(path.join(OUT, 'assets', 'docs.js'), js);
for (const f of ['logo-dark.svg', 'logo-light.svg', 'favicon.svg']) {
  fs.copyFileSync(path.join(ROOT, 'console', 'public', f), path.join(OUT, 'assets', f));
}

function navHtml(current) {
  const activeTrail = new Set(groupOf[current] || []);
  let gid = 0;
  const item = (it, depth) => {
    if (typeof it === 'string') {
      const p = bySlug[it];
      const active = it === current;
      return `<li><a class="nav-link${active ? ' active' : ''}" href="${linkOf(it)}"${active ? ' aria-current="page"' : ''}>${escapeHtml(p.navTitle)}</a></li>`;
    }
    const id = `nav-g${++gid}`;
    const contains = (x) => (typeof x === 'string' ? x === current : x.pages.some(contains));
    const open = depth === 0 || it.expanded || contains(it);
    return (
      `<li class="nav-group depth-${depth}">` +
      `<button class="nav-group-toggle" type="button" aria-expanded="${open}" aria-controls="${id}">` +
      `<span>${escapeHtml(it.group)}</span><svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` +
      `<ul id="${id}"${open ? '' : ' hidden'}>${it.pages.map((x) => item(x, depth + 1)).join('')}</ul></li>`
    );
  };
  void activeTrail;
  return tabs
    .map(
      (t) =>
        `<div class="nav-tab"><div class="nav-tab-title">${escapeHtml(t.tab)}</div><ul class="nav-root">${t.groups.map((g) => item(g, 0)).join('')}</ul></div>`
    )
    .join('');
}

function tocHtml(toc) {
  if (toc.length < 2) return '';
  return (
    `<nav class="toc" aria-label="On this page"><div class="toc-title">On this page</div><ul>` +
    toc
      .map((h) => `<li class="toc-d${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
      .join('') +
    `</ul></nav>`
  );
}

const ICON_SEARCH =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M13.5 13.5L17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_MENU =
  '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_GH =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

function pageHtml(page, idx) {
  const prev = idx > 0 ? bySlug[order[idx - 1]] : null;
  const next = idx < order.length - 1 ? bySlug[order[idx + 1]] : null;
  const trail = (groupOf[page.slug] || []).slice(1);
  const eyebrow = trail.length ? trail[trail.length - 1] : '';
  const isHome = page.slug === 'introduction';
  const docTitle = isHome ? 'Mojobase Docs' : `${page.title} · Mojobase Docs`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<meta name="color-scheme" content="dark light">
<link rel="icon" type="image/svg+xml" href="${BASE}/assets/favicon.svg">
<link rel="stylesheet" href="${BASE}/assets/docs.css?v=${ver}">
<script src="${BASE}/assets/docs.js?v=${ver}" defer></script>
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<header class="topbar">
  <button class="icon-btn menu-btn" type="button" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false" data-drawer-open>${ICON_MENU}</button>
  <a class="brand" href="${BASE}" aria-label="Mojobase Docs home">
    <picture><source srcset="${BASE}/assets/logo-light.svg" media="(prefers-color-scheme: light)"><img src="${BASE}/assets/logo-dark.svg" alt="Mojobase" width="122" height="29"></picture>
    <span class="brand-tag">Docs</span>
  </a>
  <button class="search-btn" type="button" data-search-open aria-label="Search docs">${ICON_SEARCH}<span class="search-btn-label">Search docs…</span><kbd class="kbd">/</kbd></button>
  <nav class="top-links" aria-label="Site">
    <a class="top-link" href="${CONSOLE}">Dashboard</a>
    <a class="top-link gh" href="${MOJOBASE_REPO}" rel="noopener" aria-label="GitHub">${ICON_GH}<span>GitHub</span></a>
  </nav>
</header>
<div class="layout">
  <aside class="sidebar" id="sidebar" aria-label="Documentation">
    <div class="sidebar-head"><span>Navigation</span><button class="icon-btn" type="button" aria-label="Close navigation" data-drawer-close>&times;</button></div>
    <nav>${navHtml(page.slug)}</nav>
  </aside>
  <div class="scrim" data-drawer-close hidden></div>
  <main class="main" id="content">
    <article class="doc">
      ${eyebrow ? `<div class="eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
      <h1>${escapeHtml(page.title)}</h1>
      ${page.description ? `<p class="lead">${escapeHtml(page.description)}</p>` : ''}
      <div class="prose">
${page.html}
      </div>
      <nav class="pager" aria-label="Previous and next pages">
        ${prev ? `<a class="pager-link prev" href="${linkOf(prev.slug)}"><span class="pager-dir">Previous</span><span class="pager-title">${escapeHtml(prev.navTitle)}</span></a>` : '<span></span>'}
        ${next ? `<a class="pager-link next" href="${linkOf(next.slug)}"><span class="pager-dir">Next</span><span class="pager-title">${escapeHtml(next.navTitle)}</span></a>` : '<span></span>'}
      </nav>
      <footer class="site-footer">
        <p>Mojobase is built on the open-source InsForge project (Apache-2.0).</p>
        <p><a href="${CONSOLE}">mojobase.dev</a> · <a href="${MOJOBASE_REPO}" rel="noopener">GitHub</a></p>
      </footer>
    </article>
    ${tocHtml(page.toc)}
  </main>
</div>
<div class="search-modal" data-search-modal hidden>
  <div class="search-scrim" data-search-close></div>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search documentation">
    <div class="search-input-row">${ICON_SEARCH}<input class="search-input" type="search" placeholder="Search Mojobase docs" aria-label="Search" autocomplete="off" spellcheck="false"><kbd class="kbd">Esc</kbd></div>
    <ul class="search-results" role="listbox" aria-label="Results"></ul>
    <div class="search-foot"><span><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> navigate</span><span><kbd class="kbd">↵</kbd> open</span><span><kbd class="kbd">Ctrl</kbd>/<kbd class="kbd">⌘</kbd><kbd class="kbd">K</kbd> toggle</span></div>
  </div>
</div>
</body>
</html>
`;
}

// ------------------------------------------------------------------ write

const index = [];
order.forEach((slug, i) => {
  const page = bySlug[slug];
  const dir = slug === 'introduction' ? OUT : path.join(OUT, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), pageHtml(page, i));
  const text = page.html
    .replace(/<pre[\s\S]*?<\/pre>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  index.push({
    t: page.title,
    u: linkOf(slug),
    g: (groupOf[slug] || []).slice(1).join(' › ') || groupOf[slug]?.[0] || '',
    d: page.description,
    h: page.toc.map((h) => [h.text, h.id]),
    x: text.slice(0, 5000),
  });
});
fs.writeFileSync(path.join(OUT, 'search-index.json'), JSON.stringify(index));

// ------------------------------------------------------------------ report

const excludedFound = Object.keys(EXCLUDED).filter(
  (s) => fs.existsSync(path.join(DOCS, s + '.mdx')) || fs.existsSync(path.join(DOCS, s + '.md'))
);
let bytes = 0;
(function du(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) du(p);
    else bytes += fs.statSync(p).size;
  }
})(OUT);
console.log(
  `Built ${order.length} pages into ${path.relative(ROOT, OUT)} (${(bytes / 1024 / 1024).toFixed(2)} MB, ${copiedImages.size} images).`
);
console.log(`Excluded ${excludedFound.length} source pages: ${excludedFound.join(', ')}`);
if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of [...new Set(warnings)]) console.log('  - ' + w);
}
