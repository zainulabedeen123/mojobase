// Mojobase console — a small dependency-free SPA. All user data is inserted
// with textContent (never innerHTML) so nothing a user types can run as markup.
//
// Layout follows InsForge Cloud: a top bar (org / project switcher / branch),
// an organization sidebar (Projects, Usage, AI agents, Settings), and for a
// project the real InsForge dashboard embedded in an iframe. The console plays
// the "cloud" role for that dashboard over postMessage (see the bridge below).
const $app = document.getElementById('app');
const $side = document.getElementById('sidebar');
const $top = document.getElementById('topbar');
const $shell = document.getElementById('shell');
let projectsCache = [];
let lastPath = '';
let me = null;
let pollTimer = null;

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
function go(path) { history.pushState({}, '', path); render(); }
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    closeMenus();
    const url = new URL(a.getAttribute('href'), location.origin);
    go(url.pathname + url.search + url.hash);
    return;
  }
  // Close open dropdowns when clicking elsewhere.
  for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.removeAttribute('open');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
function closeMenus() { for (const d of document.querySelectorAll('details.menu[open]')) d.removeAttribute('open'); }

// ---------------------------------------------------------------- icons (inline SVG, lucide-style strokes)
const ICONS = {
  projects: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  usage: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  agents: 'M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  chevron: 'M9 18l6-6-6-6',
  updown: 'M7 15l5 5 5-5M7 9l5-5 5 5',
  more: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  plug: 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM20 17v5H6.5a2.5 2.5 0 0 1 0-5',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  plus: 'M12 5v14M5 12h14',
  x: 'M18 6L6 18M6 6l12 12',
  menu: 'M3 12h18M3 6h18M3 18h18',
  branch: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  db: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  cloud: 'M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 13.5 3.5 3.5 0 0 0 6 19z',
  disk: 'M22 12H2M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1zM6 16h.01M10 16h.01',
};
function icon(name, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', ICONS[name]);
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- status helpers
const STATUS_LABEL = { ready: 'Active', paused: 'Paused', provisioning: 'Setting up', resuming: 'Resuming', restoring: 'Restoring', failed: 'Failed', deleting: 'Deleting' };
const statusPill = (status) => h('span', { class: `status ${status}` }, STATUS_LABEL[status] || status);
const BUSY = new Set(['provisioning', 'resuming', 'restoring', 'deleting']);
function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB`;
}
const gb = (n) => (n === null || n === undefined ? '—' : `${(n / 1073741824).toFixed(3)} GB`);
const DOCS_URL = '/docs';
const FEEDBACK_URL = 'https://github.com/zainulabedeen123/mojobase/issues';

// ---------------------------------------------------------------- top bar
function dropdown(summary, items, { align = 'left', label } = {}) {
  return h('details', { class: `menu align-${align}` },
    h('summary', { 'aria-label': label }, summary),
    h('div', { class: 'menu-panel', role: 'menu' }, items));
}
function menuItem(label, { href, onclick, external, danger, active, extra } = {}) {
  const cls = `menu-item${danger ? ' danger' : ''}${active ? ' active' : ''}`;
  if (href) return h('a', { href, class: cls, role: 'menuitem', ...(external ? { target: '_blank', rel: 'noopener' } : { 'data-link': true }) }, h('span', { class: 'grow' }, label), extra);
  return h('button', { type: 'button', class: cls, role: 'menuitem', onclick: (e) => { closeMenus(); onclick(e); } }, h('span', { class: 'grow' }, label), extra);
}
const initials = (email) => (email || '?').slice(0, 1).toUpperCase();

function renderTopbar(project) {
  $shell.classList.toggle('signed-out', !me);
  if (!me) { $top.replaceChildren(); return; }
  const menuBtn = h('button', { class: 'icon-btn side-toggle', type: 'button', 'aria-label': 'Menu', onclick: () => $side.classList.toggle('open') }, icon('menu', 18));
  const crumbs = [
    h('a', { href: '/', 'data-link': true, class: 'brand', 'aria-label': 'Mojobase home' }, h('img', { src: '/favicon.svg', alt: '', class: 'brand-mark' })),
    h('span', { class: 'sep' }, '/'),
    h('a', { href: '/', 'data-link': true, class: 'crumb' }, h('span', { class: 'org-avatar' }, 'P'), h('span', { class: 'crumb-label' }, 'Personal'), h('span', { class: `plan${planName() === 'Free' ? '' : ' paid'}` }, planName())),
  ];
  if (project) {
    crumbs.push(h('span', { class: 'sep' }, '/'),
      dropdown([h('span', { class: 'crumb-label' }, project.name), icon('updown', 14)], [
        h('div', { class: 'menu-heading' }, 'Projects'),
        projectsCache.map((p) => menuItem(p.name, { href: `/projects/${p.ref}`, active: p.ref === project.ref, extra: statusPill(p.status) })),
        h('div', { class: 'menu-sep' }),
        menuItem('All projects', { href: '/' }),
      ], { label: 'Switch project' }),
      h('span', { class: 'sep' }, '/'),
      h('span', { class: 'branch', title: 'Branch' }, icon('branch', 14), 'Main Production'));
  }
  $top.replaceChildren(
    h('div', { class: 'top-left' }, menuBtn, ...crumbs),
    h('div', { class: 'top-right' },
      project && project.status === 'ready' && h('button', { class: 'btn small', type: 'button', title: 'Copy a ready-to-paste prompt for your AI coding agent', onclick: () => openAgentPrompt(project.ref) }, icon('agents', 14), 'AI prompt'),
      project && ['ready', 'paused'].includes(project.status) && h('button', { class: 'btn small offsite-btn', type: 'button', title: 'Offsite backups: send backups to Google Drive or S3-compatible storage', 'aria-label': 'Offsite backups', onclick: () => openOffsite(project.ref) }, icon('cloud', 14), h('span', { class: 'btn-label' }, 'Offsite backups')),
      project && project.status === 'ready' && h('button', { class: 'btn small primary', type: 'button', onclick: () => openConnect(project.ref) }, icon('plug', 14), 'Connect'),
      h('a', { class: 'top-link', href: FEEDBACK_URL, target: '_blank', rel: 'noopener' }, 'Feedback'),
      h('a', { class: 'top-link', href: DOCS_URL, target: '_blank', rel: 'noopener' }, 'Docs'),
      dropdown(h('span', { class: 'avatar' }, initials(me.email)), [
        h('div', { class: 'menu-heading email' }, me.email),
        menuItem('Account settings', { href: '/settings' }),
        menuItem('AI agents (MCP)', { href: '/agents' }),
        h('div', { class: 'menu-sep' }),
        menuItem('Sign out', { onclick: logout }),
      ], { align: 'right', label: 'Account menu' })),
  );
}

// ---------------------------------------------------------------- org sidebar
function navLink(href, label, iconName, active) {
  return h('a', { href, 'data-link': true, class: `nav-item${active ? ' active' : ''}`, 'aria-current': active ? 'page' : undefined },
    icon(iconName), h('span', { class: 'nav-label' }, label));
}
function renderSidebar(section) {
  if (!me || section === 'project') { $side.replaceChildren(); return; }
  $side.replaceChildren(
    h('nav', { class: 'side-nav', 'aria-label': 'Organization' },
      navLink('/', 'Projects', 'projects', section === 'projects'),
      navLink('/usage', 'Usage', 'usage', section === 'usage'),
      navLink('/agents', 'AI agents', 'agents', section === 'agents')),
    h('nav', { class: 'side-nav side-bottom', 'aria-label': 'Settings' },
      h('a', { href: DOCS_URL, target: '_blank', rel: 'noopener', class: 'nav-item' }, icon('book'), h('span', { class: 'nav-label' }, 'Docs')),
      navLink('/settings', 'Settings', 'settings', section === 'settings')),
  );
}

async function logout() { await api('/logout', { method: 'POST', body: {} }); me = null; go('/login'); }

// ---------------------------------------------------------------- auth pages
// Animated dot-matrix backdrop for the sign-in screens (2D canvas, no libraries).
// Dots appear outward from the centre, then shimmer slowly.
function dotField(canvas) {
  const ctx = canvas.getContext('2d');
  const CELL = 22, DOT = 3;
  const LEVELS = [0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 1];
  const COLORS = ['167,139,250', '217,70,239', '251,113,133', '255,255,255', '167,139,250', '255,255,255'];
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
  let w = 0, h = 0, cols = 0, rows = 0, last = 0;
  const start = performance.now();
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(w / CELL); rows = Math.ceil(h / CELL);
  };
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    const ox = ((w % CELL) - DOT) / 2, oy = ((h % CELL) - DOT) / 2;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x, seed = hash(i, 1);
      const dist = Math.hypot(x - cols / 2, y - rows / 2);
      if (!still && t * 3 < dist * 0.035 + seed * 0.15) continue; // intro ripple
      const level = LEVELS[Math.floor(hash(i, Math.floor(t / 5 + seed) + 2) * 10)];
      ctx.fillStyle = `rgba(${COLORS[Math.floor(seed * 6)]},${level * 0.55})`;
      ctx.fillRect(ox + x * CELL, oy + y * CELL, DOT, DOT);
    }
  };
  const frame = (now) => {
    if (!canvas.isConnected) { window.removeEventListener('resize', onResize); return; }
    const t = (now - start) / 1000;
    // Full frame rate for the intro, then a slow shimmer.
    if (t < 3 || now - last > 250) { draw(t); last = now; }
    requestAnimationFrame(frame);
  };
  const onResize = () => { resize(); draw((performance.now() - start) / 1000); };
  window.addEventListener('resize', onResize);
  requestAnimationFrame(() => { resize(); if (still) draw(99); else requestAnimationFrame(frame); });
}

// Shared frame for sign-in, sign-up and the email-link pages.
function authScreen(title, subtitle, ...children) {
  const canvas = h('canvas', { class: 'auth-dots', 'aria-hidden': 'true' });
  dotField(canvas);
  return h('div', { class: 'auth-screen' },
    canvas,
    h('div', { class: 'auth-vignette', 'aria-hidden': 'true' }),
    h('a', { class: 'auth-home', href: '/', 'aria-label': 'Mojobase home' }, h('img', { src: '/logo-dark.svg', alt: 'Mojobase', height: '26' })),
    h('div', { class: 'auth-card' },
      h('img', { src: '/favicon.svg', alt: '', class: 'auth-mark' }),
      h('h1', {}, title),
      subtitle && h('p', { class: 'auth-sub' }, subtitle),
      ...children),
    h('p', { class: 'auth-foot' }, 'Free while in preview · ', h('a', { href: '/docs' }, 'Docs'), ' · ', h('a', { href: 'https://github.com/zainulabedeen123/mojobase', target: '_blank', rel: 'noopener' }, 'GitHub')));
}

function authPage(mode) {
  const isSignup = mode === 'signup';
  const err = h('div', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com', 'aria-label': 'Email' });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: isSignup ? 'new-password' : 'current-password', required: true, minlength: isSignup ? 10 : undefined,
    placeholder: isSignup ? 'Password (at least 10 characters)' : 'Password', 'aria-label': 'Password' });
  const submit = h('button', { class: 'auth-submit', type: 'submit' }, isSignup ? 'Create account' : 'Sign in');
  const form = h('form', {
    class: 'auth-form',
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try {
        await api(isSignup ? '/signup' : '/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        me = null; go('/');
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    },
  },
    email, pw, submit, err,
    !isSignup && h('a', { class: 'auth-link', href: '/forgot-password', 'data-link': true }, 'Forgot password?'));
  return authScreen(
    isSignup ? 'Create your Mojobase account' : 'Sign in to Mojobase',
    isSignup ? 'A Postgres backend for every project, ready in a minute.' : 'Welcome back. Your projects are waiting.',
    form,
    h('div', { class: 'auth-rule' }),
    h('div', { class: 'auth-switch' }, isSignup ? 'Already have an account? ' : 'New to Mojobase? ',
      h('a', { href: isSignup ? '/login' : '/signup', 'data-link': true }, isSignup ? 'Sign in' : 'Create an account')));
}

function newProjectDialog() {
  const err = h('div', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', id: 'pname', maxlength: 40, required: true, placeholder: 'my-app' });
  const create = h('button', { class: 'btn primary', type: 'submit' }, 'Create project');
  const dlg = h('dialog', {},
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; create.disabled = true;
        try { const { project } = await api('/projects', { method: 'POST', body: { name: name.value } }); dlg.close(); go(`/projects/${project.ref}?welcome=1`); }
        catch (ex) { err.textContent = ex.message; } finally { create.disabled = false; }
      },
    },
      h('h2', {}, 'New project'),
      h('label', { for: 'pname' }, 'Project name'), name,
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), create),
    ));
  return dlg;
}

function copyField(label, value, { secret = false, display } = {}) {
  let shown = !secret;
  const code = h('code', {});
  const mask = () => (code.textContent = shown ? (display ?? value) : (display ?? value).replace(/./g, '•').slice(0, 48));
  mask();
  return h('div', { class: 'field' },
    h('div', { class: 'k' }, label),
    h('div', { class: 'copy' }, code,
      secret && h('button', { class: 'btn small', type: 'button', onclick: (e) => { shown = !shown; mask(); e.currentTarget.textContent = shown ? 'Hide' : 'Reveal'; } }, 'Reveal'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { await navigator.clipboard.writeText(value); toast(`${label} copied`); } }, 'Copy')));
}

function snippets(p) {
  const db = p.database;
  const tabs = {
    'JavaScript SDK': `npm install @mojobase/sdk

import { createClient } from '@mojobase/sdk';

const mojobase = createClient({
  baseUrl: '${p.apiUrl}',
  anonKey: '${p.anonKey}',
});

const { data, error } = await mojobase.database.from('todos').select('*');`,
    '.env': `MOJOBASE_URL=${p.apiUrl}
MOJOBASE_ANON_KEY=${p.anonKey}
DATABASE_URL=${db.connectionString}`,
    Prisma: `// schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// .env
DATABASE_URL="${db.connectionString}"`,
    Drizzle: `import { drizzle } from 'drizzle-orm/node-postgres';

export const db = drizzle(process.env.DATABASE_URL);
// DATABASE_URL=${db.connectionString}`,
    psql: `psql "${db.connectionString}"`,
    REST: `curl '${p.apiUrl}/api/database/records/todos?select=*' \\
  -H 'Authorization: Bearer ${p.anonKey}'`,
  };
  const pre = h('pre', { class: 'snippet' });
  const buttons = Object.keys(tabs).map((name, i) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': i === 0 ? 'true' : 'false',
    onclick: (e) => { buttons.forEach((b) => b.setAttribute('aria-selected', 'false')); e.currentTarget.setAttribute('aria-selected', 'true'); pre.textContent = tabs[name]; },
  }, name));
  pre.textContent = tabs['JavaScript SDK'];
  return h('div', {}, h('div', { class: 'tabs', role: 'tablist' }, buttons), pre,
    h('button', { class: 'btn small', type: 'button', onclick: async () => { await navigator.clipboard.writeText(pre.textContent); toast('Snippet copied'); } }, 'Copy snippet'));
}

// ---------------------------------------------------------------- email flows
function verifyBanner() {
  const btn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    btn.disabled = true;
    try { await api('/resend-verification', { method: 'POST', body: {} }); toast('Verification email sent'); }
    catch (e) { toast(e.message); } finally { setTimeout(() => (btn.disabled = false), 30000); }
  } }, 'Resend email');
  return h('div', { class: 'card row spread', style: 'border-color:color-mix(in srgb, var(--warn) 50%, var(--border))' },
    h('div', {}, h('strong', {}, 'Confirm your email to create projects'),
      h('div', { class: 'muted', style: 'font-size:14px' }, `We sent a link to ${me.email}. Check your inbox (and spam folder).`)),
    btn);
}

function simpleCard(title, ...children) {
  return authScreen(title, null, h('div', { class: 'auth-body' }, ...children));
}

async function verifyPage() {
  const token = new URLSearchParams(location.search).get('token');
  try {
    await api('/verify', { method: 'POST', body: { token } });
    me = null;
    return simpleCard('Email confirmed', h('p', {}, 'Thanks — your email address is confirmed. You can create projects now.'),
      h('a', { class: 'btn primary', href: '/', 'data-link': true }, 'Go to projects'));
  } catch (e) {
    return simpleCard('Link not valid', h('p', { class: 'muted' }, e.message + '. Sign in and use “Resend email” to get a new link.'),
      h('a', { class: 'btn', href: '/', 'data-link': true }, 'Back to Mojobase'));
  }
}

function forgotPage() {
  const err = h('div', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true, placeholder: 'you@company.com', 'aria-label': 'Email' });
  const btn = h('button', { class: 'auth-submit', type: 'submit' }, 'Send reset link');
  const box = h('div', {});
  const form = h('form', { class: 'auth-form', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    try {
      await api('/forgot-password', { method: 'POST', body: { email: email.value } });
      box.replaceChildren(h('p', {}, `If an account exists for ${email.value}, a reset link is on its way. It expires in 1 hour.`),
        h('a', { href: '/login', 'data-link': true }, 'Back to sign in'));
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  } }, email, btn, err);
  box.append(h('p', { class: 'auth-sub' }, 'Enter your email and we will send you a link to choose a new password.'), form,
    h('div', { class: 'auth-rule' }), h('div', { class: 'auth-switch' }, h('a', { href: '/login', 'data-link': true }, 'Back to sign in')));
  return simpleCard('Reset your password', box);
}

function resetPage() {
  const token = new URLSearchParams(location.search).get('token');
  const err = h('div', { class: 'error', role: 'alert' });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'new-password', required: true, minlength: 10, placeholder: 'New password (at least 10 characters)', 'aria-label': 'New password' });
  const btn = h('button', { class: 'auth-submit', type: 'submit' }, 'Set new password');
  return simpleCard('Choose a new password', h('form', { class: 'auth-form', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    try {
      await api('/reset-password', { method: 'POST', body: { token, password: pw.value } });
      me = null; toast('Password changed'); go('/');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  } }, pw, btn, err,
    h('div', { class: 'auth-hint' }, 'You will be signed out everywhere else.')));
}

// ---------------------------------------------------------------- account
function accountPage() {
  const err = h('div', { class: 'error', role: 'alert' });
  const pw = h('input', { type: 'password', id: 'delpw', autocomplete: 'current-password' });
  const confirmBtn = h('button', { class: 'btn danger', type: 'submit' }, 'Delete my account');
  const dlg = h('dialog', {}, h('form', { onsubmit: async (e) => {
    e.preventDefault(); confirmBtn.disabled = true; err.textContent = 'Deleting projects…';
    try { await api('/account/delete', { method: 'POST', body: { password: pw.value } }); dlg.close(); me = null; toast('Account deleted'); go('/signup'); }
    catch (ex) { err.textContent = ex.message; confirmBtn.disabled = false; }
  } },
    h('h2', {}, 'Delete your account?'),
    h('p', { class: 'muted' }, 'This permanently deletes every project you own — databases, users, files, functions and backups — and then your account. It cannot be undone.'),
    h('label', { for: 'delpw' }, 'Enter your password to confirm'), pw, err,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), confirmBtn)));
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Your account and organization.'))),
    h('div', { class: 'card' },
      h('h2', {}, 'Organization'),
      h('div', { class: 'grid2' }, copyField('Name', 'Personal'), copyField('Plan', planName())),
      h('p', { class: 'muted small', style: 'margin:0' }, planNote())),
    me.isAdmin && adminCard(),
    h('div', { class: 'card' },
      copyField('Email', me.email),
      h('p', { class: 'muted', style: 'margin:0' }, me.emailVerified ? 'Email confirmed.' : 'Email not confirmed yet.'),
      h('div', { class: 'row', style: 'margin-top:14px' }, h('a', { class: 'btn', href: '/forgot-password', 'data-link': true, onclick: async (e) => {
        e.preventDefault();
        await api('/forgot-password', { method: 'POST', body: { email: me.email } });
        toast('Password reset link sent to your email');
      } }, 'Change password'))),
    h('div', { class: 'card' },
      h('h2', {}, 'Delete account'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Deletes all of your projects and their data, then your account.'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => dlg.showModal() }, 'Delete account'), dlg));
}

// ---------------------------------------------------------------- AI agents (MCP)
const MCP_URL = `${location.origin}/mcp`;
function mcpSetups(token) {
  return {
    'Claude Code': `claude mcp add --transport http mojobase ${MCP_URL} \\
  --header "Authorization: Bearer ${token}"`,
    'Cursor / Windsurf': `// ~/.cursor/mcp.json  (Windsurf: ~/.codeium/windsurf/mcp_config.json)
{
  "mcpServers": {
    "mojobase": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`,
    'VS Code': `// .vscode/mcp.json
{
  "servers": {
    "mojobase": {
      "type": "http",
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer ${token}" }
    }
  }
}`,
    'Claude Desktop / others': `// For clients that only run local (stdio) servers, bridge with mcp-remote:
{
  "mcpServers": {
    "mojobase": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${MCP_URL}", "--header", "Authorization: Bearer ${token}"]
    }
  }
}`,
  };
}
function tabbedSnippets(tabs) {
  const pre = h('pre', { class: 'snippet' });
  const names = Object.keys(tabs);
  const buttons = names.map((name, i) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': i === 0 ? 'true' : 'false',
    onclick: (e) => { buttons.forEach((b) => b.setAttribute('aria-selected', 'false')); e.currentTarget.setAttribute('aria-selected', 'true'); pre.textContent = tabs[name]; },
  }, name));
  pre.textContent = tabs[names[0]];
  return h('div', {}, h('div', { class: 'tabs', role: 'tablist' }, buttons), pre,
    h('button', { class: 'btn small', type: 'button', onclick: async () => { await navigator.clipboard.writeText(pre.textContent); toast('Copied'); } }, 'Copy'));
}
function mcpCard() {
  const list = h('div', {});
  const created = h('div', {});
  const err = h('div', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', id: 'tokname', maxlength: 40, placeholder: 'e.g. Claude Code on my laptop' });
  const load = async () => {
    const { tokens } = await api('/tokens');
    list.replaceChildren(...(tokens.length ? tokens.map((tk) => h('div', { class: 'copy', style: 'margin-bottom:8px' },
      h('code', {}, `${tk.name} · mbp_…${tk.hint} · ${tk.last_used_at ? 'last used ' + new Date(tk.last_used_at + 'Z').toLocaleString() : 'never used'}`),
      h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
        if (!confirm(`Revoke "${tk.name}"? Agents using it will lose access.`)) return;
        await api(`/tokens/${tk.id}`, { method: 'DELETE' }); toast('Token revoked'); load();
      } }, 'Revoke'))) : [h('p', { class: 'muted' }, 'No tokens yet.')]));
  };
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create token');
  const form = h('form', { class: 'row', style: 'align-items:flex-end', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = ''; btn.disabled = true;
    try {
      const { token } = await api('/tokens', { method: 'POST', body: { name: name.value } });
      name.value = '';
      created.replaceChildren(h('div', { class: 'card', style: 'background:var(--panel-2)' },
        h('strong', {}, 'Copy your token now — it won’t be shown again.'),
        copyField('Access token', token, { secret: true }),
        h('div', { class: 'k', style: 'font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:8px 0 6px' }, 'Connect your agent'),
        tabbedSnippets(mcpSetups(token))));
      load();
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  } }, h('div', { style: 'flex:1;min-width:220px' }, h('label', { for: 'tokname', style: 'margin-top:0' }, 'Token name'), name), btn);
  load().catch((e) => list.replaceChildren(h('p', { class: 'error' }, e.message)));
  return h('div', { class: 'card', id: 'mcp' },
    h('h2', {}, 'MCP server'),
    h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Connect Claude Code, Cursor, Windsurf, VS Code or any MCP client to Mojobase. Agents can create projects, run SQL, manage storage and functions, and get your connection details. A token has the same access as your account — revoke it any time.'),
    copyField('MCP server URL', MCP_URL),
    form, err, created,
    h('div', { class: 'k', style: 'font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 6px' }, 'Your tokens'),
    list);
}

// ---------------------------------------------------------------- projects (org home)
function projectCard(p) {
  const u = p.usage;
  const actions = [];
  if (p.status === 'ready') actions.push(menuItem('Pause project', { onclick: () => pauseResume(p, true) }));
  if (p.status === 'paused') actions.push(menuItem('Resume project', { onclick: () => pauseResume(p, false) }));
  if (p.status === 'failed') actions.push(menuItem('Retry setup', { onclick: async () => { await api(`/projects/${p.ref}/retry`, { method: 'POST', body: {} }); render(); } }));
  if (p.status === 'ready') actions.push(menuItem('Copy AI agent prompt', { onclick: () => copyAgentPrompt(p.ref) }));
  actions.push(menuItem('Copy project URL', { onclick: async () => { await navigator.clipboard.writeText(p.apiUrl); toast('Project URL copied'); } }));
  if (!BUSY.has(p.status)) actions.push(h('div', { class: 'menu-sep' }), menuItem('Delete project', { danger: true, onclick: () => confirmDelete(p) }));
  return h('div', { class: 'project-card' },
    h('a', { class: 'card-link', href: `/projects/${p.ref}`, 'data-link': true, 'aria-label': `Open ${p.name}` }),
    h('div', { class: 'pc-head' },
      h('div', { class: 'pc-title' }, h('h3', {}, p.name), h('span', { class: 'tier' }, 'NANO')),
      dropdown(icon('more'), actions, { align: 'right', label: `${p.name} actions` })),
    h('div', { class: 'pc-meta' }, statusPill(p.status), h('span', { class: 'mono muted' }, p.apiUrl.replace('https://', ''))),
    h('div', { class: 'pc-stats' },
      h('div', {}, h('div', { class: 'k' }, icon('db', 13), 'Database'), h('div', { class: 'v' }, gb(u?.databaseBytes))),
      h('div', {}, h('div', { class: 'k' }, icon('disk', 13), 'Storage'), h('div', { class: 'v' }, gb(u?.storageBytes))),
      h('span', { class: 'pc-chevron' }, icon('chevron', 18))));
}

async function pauseResume(p, pause) {
  try {
    await api(`/projects/${p.ref}/${pause ? 'pause' : 'resume'}`, { method: 'POST', body: {} });
    toast(pause ? `${p.name} paused` : `Resuming ${p.name}…`);
  } catch (e) { toast(e.message); }
  render();
}

function confirmDelete(p, { after } = {}) {
  const err = h('div', { class: 'error' });
  const input = h('input', { type: 'text', id: 'confirm', autocomplete: 'off' });
  const btn = h('button', { class: 'btn danger', type: 'submit' }, 'Delete forever');
  const dlg = h('dialog', { onclose: () => dlg.remove() }, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (input.value !== p.name) { err.textContent = 'Type the project name exactly to confirm.'; return; }
      btn.disabled = true;
      try { await api(`/projects/${p.ref}`, { method: 'DELETE' }); dlg.close(); toast(`Deleting ${p.name}…`); after ? after() : render(); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    },
  },
    h('h2', {}, `Delete ${p.name}?`),
    h('p', { class: 'muted' }, 'This permanently deletes the database, users, files, functions and backups. It cannot be undone.'),
    h('label', { for: 'confirm' }, `Type "${p.name}" to confirm`), input, err,
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), btn)));
  document.body.append(dlg);
  dlg.showModal();
}

function agentPrompt() {
  if (store.get('mb.hideAgentCard') === '1') return null;
  const card = h('div', { class: 'agent-card' },
    h('div', { class: 'agent-icon' }, icon('agents', 20)),
    h('div', { class: 'grow' },
      h('strong', {}, 'Connect your coding agent'),
      h('div', { class: 'muted' }, 'Let Claude Code, Cursor, Windsurf or VS Code create projects, run SQL and wire Mojobase into your app through MCP.')),
    h('a', { class: 'btn small', href: '/agents', 'data-link': true }, 'Set up'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => { store.set('mb.hideAgentCard', '1'); card.remove(); } }, icon('x', 16)));
  return card;
}

function projectsPage() {
  const projects = projectsCache;
  const limit = projectLimit();
  const needsVerify = me.requireVerifiedEmail && !me.emailVerified;
  const atLimit = limit !== null && projects.length >= limit;
  const dlg = newProjectDialog();
  const grid = h('div', { class: 'project-grid' });
  const search = h('input', { type: 'search', class: 'search', placeholder: 'Search projects', 'aria-label': 'Search projects', value: store.get('mb.q') || '' });
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q) || p.ref.includes(q));
    grid.replaceChildren(...(shown.length ? shown.map(projectCard) : [h('p', { class: 'muted' }, 'No projects match your search.')]));
  };
  search.addEventListener('input', draw);
  draw();
  const newBtn = h('button', { class: 'btn primary', type: 'button', disabled: atLimit || needsVerify, title: atLimit ? `The Free plan includes ${limit} projects. Unlimited projects are available on Pro.` : needsVerify ? 'Confirm your email first' : undefined, onclick: () => dlg.showModal() }, icon('plus', 15), 'New Project');
  if (BUSY_ANY()) pollTimer = setTimeout(render, 4000);
  return h('div', { class: 'page' },
    needsVerify && verifyBanner(),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub' }, limit === null ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'} · unlimited on the ${planName()} plan` : `${projects.length} of ${limit} projects on the Free plan`))),
    projects.length
      ? [h('div', { class: 'toolbar' }, h('div', { class: 'search-wrap' }, icon('search', 15), search), newBtn), grid]
      : h('div', { class: 'card empty' },
          h('h2', {}, 'Create your first project'),
          h('p', { class: 'muted' }, 'Each project gets its own Postgres database, auth, storage, edge functions, realtime, a model gateway, API keys and a connection string.'),
          newBtn),
    agentPrompt(),
    dlg);
}
const BUSY_ANY = () => projectsCache.some((p) => BUSY.has(p.status));

// ---------------------------------------------------------------- plans
// perUser is null when the account has no project limit (admins and Pro accounts).
const projectLimit = () => (me.limits && me.limits.perUser === null ? null : me.limits?.perUser ?? 2);
const planName = () => me?.planLabel || 'Free';
const planNote = () => ({
  Admin: 'You are a platform admin: unlimited projects, and you can grant Pro to other accounts below.',
  Pro: 'Pro: unlimited projects.',
}[planName()] || `Free: up to ${projectLimit()} projects. Unlimited projects are available on Pro.`);

// Admin only: every account, with a switch between Free and Pro.
function adminCard() {
  const body = h('div', {}, h('span', { class: 'spinner' }));
  const filter = h('input', { type: 'search', class: 'search admin-search', placeholder: 'Filter by email', 'aria-label': 'Filter accounts by email' });
  let users = [];
  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const rows = users.filter((u) => !q || u.email.toLowerCase().includes(q));
    body.replaceChildren(h('div', { class: 'card flush', style: 'margin:0' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['Account', 'Projects', 'Plan', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.length ? rows.map((u) => h('tr', {},
        h('td', {}, u.email, !u.emailVerified && h('span', { class: 'muted small' }, ' · unconfirmed')),
        h('td', { class: 'mono' }, String(u.projects)),
        h('td', {}, h('span', { class: `plan${u.isAdmin || u.plan === 'pro' ? ' paid' : ''}` }, u.isAdmin ? 'Admin' : u.plan === 'pro' ? 'Pro' : 'Free')),
        h('td', { style: 'text-align:right' }, !u.isAdmin && h('button', { class: 'btn small', type: 'button', onclick: async (e) => {
          e.currentTarget.disabled = true;
          const plan = u.plan === 'pro' ? 'free' : 'pro';
          try { await api(`/admin/users/${u.id}/plan`, { method: 'POST', body: { plan } }); toast(`${u.email} is now ${plan === 'pro' ? 'Pro' : 'Free'}`); await load(); }
          catch (ex) { toast(ex.message); e.currentTarget.disabled = false; }
        } }, u.plan === 'pro' ? 'Move to Free' : 'Make Pro'))))
        : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'No accounts match.'))))));
  };
  const load = async () => { users = (await api('/admin/users')).users; draw(); };
  filter.addEventListener('input', draw);
  load().catch((e) => body.replaceChildren(h('p', { class: 'error' }, e.message)));
  return h('div', { class: 'card', id: 'admin' },
    h('div', { class: 'row spread', style: 'margin-bottom:12px' }, h('h2', { style: 'margin:0' }, 'Accounts and plans'), filter),
    h('p', { class: 'muted small', style: 'margin:0 0 12px' }, 'Pro accounts can create unlimited projects. Moving an account back to Free keeps its existing projects but stops it creating more beyond the Free limit.'),
    body);
}

// ---------------------------------------------------------------- usage
function usagePage() {
  const limit = projectLimit();
  const sum = (k) => projectsCache.reduce((n, p) => n + (p.usage?.[k] || 0), 0);
  const tile = (label, value, hint) => h('div', { class: 'tile' }, h('div', { class: 'k' }, label), h('div', { class: 'big' }, value), hint && h('div', { class: 'muted small' }, hint));
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Usage'), h('p', { class: 'sub' }, 'Resources used by the projects in your organization. Sizes refresh every few minutes.'))),
    h('div', { class: 'tiles' },
      tile('Projects', limit === null ? String(projectsCache.length) : `${projectsCache.length} / ${limit}`, limit === null ? `Unlimited on the ${planName()} plan` : 'Free plan'),
      tile('Active projects', String(projectsCache.filter((p) => p.status === 'ready').length), 'Paused projects use no compute'),
      tile('Database size', fmtBytes(sum('databaseBytes')), 'All projects'),
      tile('Storage size', fmtBytes(sum('storageBytes')), 'Uploaded files')),
    h('div', { class: 'card flush' },
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Project', 'Status', 'Instance', 'Database', 'Storage'].map((t) => h('th', {}, t)))),
        h('tbody', {}, projectsCache.length
          ? projectsCache.map((p) => h('tr', {},
              h('td', {}, h('a', { href: `/projects/${p.ref}`, 'data-link': true }, p.name)),
              h('td', {}, statusPill(p.status)), h('td', {}, 'Nano'),
              h('td', { class: 'mono' }, fmtBytes(p.usage?.databaseBytes)), h('td', { class: 'mono' }, fmtBytes(p.usage?.storageBytes))))
          : h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'No projects yet.'))))));
}

// ---------------------------------------------------------------- AI agents + settings pages
function agentsPage() {
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'AI agents'), h('p', { class: 'sub' }, 'Give coding agents direct access to Mojobase through the Model Context Protocol.'))),
    mcpCard());
}

// ---------------------------------------------------------------- project: embedded dashboard
// One live iframe at a time; kept across re-renders so the dashboard never reloads
// while you work in it (status polling, project switcher refreshes, etc.).
const bridge = { ref: null, frame: null, origin: null };
const localStatus = new Map(); // ref -> status shown while a long request runs (restore)

function projectFor(ref) {
  const p = projectsCache.find((x) => x.ref === ref);
  if (!p) return null;
  return localStatus.has(ref) ? { ...p, status: localStatus.get(ref) } : p;
}

function statusPanel(p) {
  const busyText = {
    provisioning: ['Setting up your backend…', 'Creating the Postgres database, auth, storage and functions. This takes about a minute — then you get a ready-to-paste prompt for your AI coding agent.'],
    resuming: ['Resuming project…', 'Starting the database and services again.'],
    restoring: ['Restoring backup…', 'The project is offline while the database is replaced. A safety backup was taken first.'],
    deleting: ['Deleting project…', 'Removing the database, files and functions.'],
  }[p.status];
  if (busyText) {
    pollTimer = setTimeout(render, 3000);
    return h('div', { class: 'center-panel' }, h('span', { class: 'spinner big' }), h('h2', {}, busyText[0]), h('p', { class: 'muted' }, busyText[1]));
  }
  if (p.status === 'paused') {
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => { btn.disabled = true; pauseResume(p, false); } }, 'Resume project');
    return h('div', { class: 'center-panel' }, h('h2', {}, `${p.name} is paused`), h('p', { class: 'muted' }, 'Its data is kept, but the API, database and dashboard are offline until you resume it.'), btn);
  }
  return h('div', { class: 'center-panel' },
    h('h2', {}, 'Setup failed'), h('pre', { class: 'snippet' }, p.error || 'Unknown error'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => { await api(`/projects/${p.ref}/retry`, { method: 'POST', body: {} }); render(); } }, 'Try again'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => confirmDelete(p, { after: () => go('/') }) }, 'Delete project')));
}

function projectPage(ref, sub) {
  const p = projectFor(ref);
  if (!p) return h('div', { class: 'page' }, h('div', { class: 'card' }, h('h2', {}, 'Project not found'), h('a', { href: '/', 'data-link': true }, 'Back to projects')));
  if (p.status !== 'ready') { bridge.ref = null; bridge.frame = null; return statusPanel(p); }
  if (bridge.ref === ref && bridge.frame?.isConnected) return null; // keep the live dashboard
  const origin = new URL(p.apiUrl).origin;
  const path = /^\/dashboard(\/[\w\-/]*)?$/.test(sub || '') ? sub : '/dashboard';
  const frame = h('iframe', {
    class: 'dash-frame', title: `${p.name} dashboard`, src: `${origin}${path}`,
    referrerpolicy: 'origin', allow: 'clipboard-read; clipboard-write',
  });
  frame.addEventListener('load', () => sendProjectInfo());
  Object.assign(bridge, { ref, frame, origin });
  if (new URLSearchParams(location.search).get('welcome') === '1') {
    history.replaceState({}, '', location.pathname);
    setTimeout(() => openAgentPrompt(ref, { welcome: true }), 0);
  }
  return frame;
}

function sendToFrame(msg) { bridge.frame?.contentWindow?.postMessage(msg, bridge.origin); }
function sendProjectInfo() {
  const p = projectFor(bridge.ref);
  if (p) sendToFrame({ type: 'PROJECT_INFO', id: p.ref, name: p.name, region: 'eu-central', instanceType: 'nano', status: p.status === 'ready' ? 'active' : p.status });
}
const toDashBackup = (b) => ({
  id: b.file, name: b.name ?? null, triggerSource: b.trigger === 'scheduled' ? 'scheduled' : 'manual',
  status: 'completed', sizeBytes: b.size ?? null, expiresAt: null, createdAt: String(b.createdAt), createdBy: b.createdBy ?? null,
});
const NANO = { id: 'nano', name: 'Nano', cpu: '0.5 vCPU', ram: '768 MB', cpuCores: 0.5, memoryGb: 0.75, pricePerHour: 0, pricePerMonth: 0 };

window.addEventListener('message', (e) => {
  if (!bridge.frame || e.source !== bridge.frame.contentWindow || e.origin !== bridge.origin) return;
  const msg = e.data;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  const ref = bridge.ref;
  const enc = (s) => encodeURIComponent(String(s ?? ''));
  const result = (type, fn) => fn().then((extra) => sendToFrame({ type, success: true, ...(extra || {}) }), (err) => sendToFrame({ type, success: false, error: err.message }));
  switch (msg.type) {
    case 'REQUEST_PROJECT_INFO': return sendProjectInfo();
    case 'REQUEST_AUTHORIZATION_CODE':
      return void api(`/projects/${ref}/authorization-code`, { method: 'POST', body: {} })
        .then(({ code }) => sendToFrame({ type: 'AUTHORIZATION_CODE', code }), (err) => sendToFrame({ type: 'AUTHORIZATION_CODE_ERROR', error: err.message }));
    case 'REQUEST_USER_INFO': return sendToFrame({ type: 'USER_INFO', userId: me.id, email: me.email, name: me.email.split('@')[0] });
    case 'REQUEST_BACKUP_INFO':
      return void api(`/projects/${ref}/backups`).then(({ backups }) => {
        const all = backups.map(toDashBackup);
        sendToFrame({ type: 'BACKUP_INFO', manualBackups: all.filter((b) => b.triggerSource === 'manual'), scheduledBackups: all.filter((b) => b.triggerSource === 'scheduled') });
      }, (err) => sendToFrame({ type: 'BACKUP_INFO_ERROR', error: err.message }));
    case 'CREATE_BACKUP': return void result('BACKUP_CREATE_RESULT', () => api(`/projects/${ref}/backups`, { method: 'POST', body: { name: msg.name ? String(msg.name) : undefined } }));
    case 'DELETE_BACKUP': return void result('BACKUP_DELETE_RESULT', () => api(`/projects/${ref}/backups/${enc(msg.backupId)}`, { method: 'DELETE' }));
    case 'RENAME_BACKUP': return void result('BACKUP_RENAME_RESULT', () => api(`/projects/${ref}/backups/${enc(msg.backupId)}`, { method: 'PATCH', body: { name: String(msg.name || '') } }));
    case 'RESTORE_BACKUP': {
      // A restore takes the project offline for a while; acknowledge right away,
      // show the restoring screen, and bring the dashboard back when it finishes.
      sendToFrame({ type: 'BACKUP_RESTORE_RESULT', success: true });
      localStatus.set(ref, 'restoring');
      api(`/projects/${ref}/backups/${enc(msg.backupId)}/restore`, { method: 'POST', body: {} })
        .then(() => toast('Backup restored'), (err) => toast(err.message))
        .finally(() => { localStatus.delete(ref); render(); });
      return void setTimeout(render, 300);
    }
    case 'UPDATE_PROJECT_NAME':
      return void api(`/projects/${ref}`, { method: 'PATCH', body: { name: String(msg.name || '') } })
        .then(async ({ project }) => {
          sendToFrame({ type: 'PROJECT_NAME_UPDATE_RESULT', success: true, name: project.name });
          projectsCache = (await api('/projects')).projects;
          renderTopbar(projectFor(ref));
        }, (err) => sendToFrame({ type: 'PROJECT_NAME_UPDATE_RESULT', success: false, error: err.message }));
    case 'DELETE_PROJECT':
      return void api(`/projects/${ref}`, { method: 'DELETE' })
        .then(() => { sendToFrame({ type: 'DELETE_PROJECT_RESULT', success: true }); toast('Deleting project…'); setTimeout(() => go('/'), 400); },
          (err) => sendToFrame({ type: 'DELETE_PROJECT_RESULT', success: false, error: err.message }));
    case 'REQUEST_INSTANCE_INFO':
      return sendToFrame({ type: 'INSTANCE_INFO', currentInstanceType: 'nano', planName: 'free preview', isPartnerOrg: false, computeCredits: 0, currentOrgComputeCost: 0, instanceTypes: [NANO],
        projects: projectsCache.map((p) => ({ id: p.ref, name: p.name, instanceType: 'nano', status: p.status === 'ready' ? 'active' : p.status })) });
    case 'REQUEST_INSTANCE_TYPE_CHANGE': return sendToFrame({ type: 'INSTANCE_TYPE_CHANGE_RESULT', success: false, error: 'Mojobase runs every project on the Nano instance for now.' });
    case 'UPDATE_PROJECT_VERSION': return sendToFrame({ type: 'VERSION_UPDATE_RESULT', success: false, error: 'Mojobase updates projects automatically.' });
    case 'REQUEST_USER_API_KEY': return sendToFrame({ type: 'USER_API_KEY_ERROR', error: 'Use an access token from AI agents (MCP) in the Mojobase console.' });
    case 'REQUEST_MODEL_CREDITS': return sendToFrame({ type: 'MODEL_CREDITS_ERROR', error: 'Model credits are not available on Mojobase. Add your own OpenRouter key in Model Gateway settings.' });
    case 'REQUEST_PROJECT_METRICS': return sendToFrame({ type: 'PROJECT_METRICS_ERROR', code: 'unavailable' });
    case 'APP_ROUTE_CHANGE':
      if (typeof msg.path === 'string' && /^\/dashboard[\w\-/]*$/.test(msg.path)) history.replaceState({}, '', `/projects/${ref}${msg.path === '/dashboard' ? '' : msg.path}`);
      return;
    case 'OPEN_AGENT_PROMPT': return void openAgentPrompt(ref);
    case 'REQUEST_AGENT_PROMPT':
      return void api(`/projects/${ref}/agent-prompt`)
        .then(({ prompt }) => sendToFrame({ type: 'AGENT_PROMPT', prompt }), (err) => sendToFrame({ type: 'AGENT_PROMPT_ERROR', error: err.message }));
    case 'OPEN_WHATS_NEW': return void window.open('https://github.com/zainulabedeen123/mojobase/commits/main', '_blank', 'noopener');
    case 'SHOW_UPGRADE_DIALOG': return toast('Paid plans are not available yet — everything on Mojobase is free for now.');
    default:
      if (/POSTHOG|APIFY/.test(msg.type) && /^(OPEN|CONNECT|REQUEST)/.test(msg.type))
        sendToFrame({ type: msg.type.includes('POSTHOG') ? 'POSTHOG_CONNECTION_STATUS' : 'APIFY_CONNECTION_STATUS', status: 'error', reason: 'This integration is not available on Mojobase yet.', timestamp: Date.now() });
  }
});

// ---------------------------------------------------------------- AI agent prompt
async function copyText(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
  catch { toast('Copy failed — select the text and copy it manually'); }
}
async function copyAgentPrompt(ref) {
  try { const { prompt } = await api(`/projects/${ref}/agent-prompt`); await copyText(prompt, 'AI agent prompt'); }
  catch (e) { toast(e.message); }
}
async function openAgentPrompt(ref, { welcome = false } = {}) {
  let prompt;
  try { ({ prompt } = await api(`/projects/${ref}/agent-prompt`)); } catch (e) { return toast(e.message); }
  const p = projectFor(ref);
  const copyBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    await copyText(prompt, 'AI agent prompt'); copyBtn.textContent = 'Copied ✓'; setTimeout(() => (copyBtn.textContent = 'Copy prompt'), 2000);
  } }, 'Copy prompt');
  const download = () => {
    const url = URL.createObjectURL(new Blob([prompt], { type: 'text/markdown' }));
    const a = h('a', { href: url, download: `mojobase-${p?.name || ref}-integration.md` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const dlg = h('dialog', { class: 'prompt-dialog', onclose: () => dlg.remove() },
    h('div', { class: 'drawer-head' },
      h('div', { class: 'row', style: 'gap:10px' }, h('span', { class: 'agent-icon small' }, icon('agents', 16)),
        h('h2', {}, welcome ? `${p?.name || 'Your project'} is ready` : 'AI agent prompt')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('div', { class: 'drawer-body' },
      h('p', {}, 'Paste this into Claude Code, Cursor, Codex, Windsurf, Copilot or any coding agent, inside your app\'s folder. It has everything needed to integrate this project: URL, keys, connection string, schema and security setup, auth, database, storage, functions and realtime.'),
      h('div', { class: 'warn-note' }, 'It contains your secret API key and database password. Paste it only into tools you trust, and don\'t commit it.'),
      h('div', { class: 'row', style: 'margin:14px 0' }, copyBtn,
        h('button', { class: 'btn', type: 'button', onclick: download }, 'Download .md'),
        welcome && h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Open dashboard')),
      h('pre', { class: 'snippet prompt-text', tabindex: '0' }, prompt)));
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------------------------------------------------------- Connect drawer
async function openConnect(ref) {
  const { project: p } = await api(`/projects/${ref}`);
  if (!p.database) return toast('Connection details appear once the project is active.');
  const db = p.database;
  const section = (title, ...kids) => h('section', { class: 'drawer-section' }, h('h3', {}, title), ...kids);
  const dlg = h('dialog', { class: 'drawer', onclose: () => dlg.remove() },
    h('div', { class: 'drawer-head' }, h('h2', {}, `Connect to ${p.name}`), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('div', { class: 'drawer-body' },
      section('AI agent prompt', h('p', { class: 'muted' }, 'One prompt with every key and step your coding agent needs to integrate this project.'),
        h('div', { class: 'row' }, h('button', { class: 'btn small primary', type: 'button', onclick: () => copyAgentPrompt(ref) }, 'Copy prompt'),
          h('button', { class: 'btn small', type: 'button', onclick: () => { dlg.close(); openAgentPrompt(ref); } }, 'View prompt'))),
      section('Quick start', h('p', { class: 'muted' }, 'Use the SDK or REST API from your app, or connect straight to Postgres with an ORM.'), snippets(p)),
      section('API', copyField('Project URL', p.apiUrl), copyField('Anon key (safe for browsers and apps)', p.anonKey), copyField('API key (secret — server-side only)', p.apiKey, { secret: true })),
      section('Database',
        copyField('Connection string', db.connectionString, { secret: true }),
        h('div', { class: 'grid2' }, copyField('Host', db.host), copyField('Port', String(db.port)), copyField('Database', db.database), copyField('User', db.user)),
        copyField('Password', db.password, { secret: true }),
        h('p', { class: 'muted small' }, 'TLS is required (sslmode=require). The role has full access to your tables, without server superuser rights.')),
      section('AI agents', h('p', { class: 'muted' }, 'Prefer to let your coding agent do it? ', h('a', { href: '/agents', 'data-link': true, onclick: () => dlg.close() }, 'Connect it over MCP'), '.')),
      section('Direct dashboard login', h('p', { class: 'muted' }, 'You are signed in automatically here. To open the dashboard on its own URL, use:'),
        h('div', { class: 'grid2' }, copyField('Username', p.dashboard.username), copyField('Password', p.dashboard.password, { secret: true })),
        h('a', { class: 'btn small', href: p.dashboardUrl, target: '_blank', rel: 'noopener' }, 'Open in new tab ↗'))));
  document.body.append(dlg);
  dlg.showModal();
}

// ---------------------------------------------------------------- Offsite backups drawer
// Copies of the database and uploaded files go to the owner's own Google Drive or
// S3-compatible storage on a schedule. Saved keys never come back from the API.
const S3_PRESETS = {
  aws: { name: 'AWS S3', endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', pathStyle: false, hint: 'Endpoint for your bucket\'s region, e.g. https://s3.eu-west-1.amazonaws.com' },
  r2: { name: 'Cloudflare R2', endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto', pathStyle: true, hint: 'From R2 → Manage API tokens. Region is "auto".' },
  b2: { name: 'Backblaze B2', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', pathStyle: false, hint: 'Use the bucket\'s S3 endpoint and an application key.' },
  wasabi: { name: 'Wasabi', endpoint: 'https://s3.eu-central-1.wasabisys.com', region: 'eu-central-1', pathStyle: false, hint: 'Use your bucket\'s region endpoint.' },
  other: { name: 'MinIO / other', endpoint: 'https://s3.example.com', region: 'us-east-1', pathStyle: true, hint: 'Any S3-compatible service. Private or http:// endpoints need ALLOW_PRIVATE_S3_ENDPOINTS=1 on the server.' },
};
const OFFSITE_RUN = { ok: ['ready', 'Completed'], partial: ['provisioning', 'Partly failed'], failed: ['failed', 'Failed'], running: ['provisioning', 'Running'] };
const runPill = (status) => { const [cls, text] = OFFSITE_RUN[status] || ['', status]; return h('span', { class: `status ${cls}` }, text); };
const pad2 = (n) => String(n).padStart(2, '0');
const localHour = (utcHour) => { const d = new Date(); d.setUTCHours(utcHour, 0, 0, 0); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDuration = (ms) => (ms === null || ms === undefined ? '' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

let offsiteTimer = null;
async function openOffsite(ref, { notice } = {}) {
  const p = projectFor(ref);
  const body = h('div', { class: 'drawer-body' }, h('div', { class: 'center-panel' }, h('span', { class: 'spinner' })));
  const dlg = h('dialog', { class: 'drawer', onclose: () => { clearTimeout(offsiteTimer); dlg.remove(); } },
    h('div', { class: 'drawer-head' }, h('h2', {}, 'Offsite backups'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    body);
  document.body.append(dlg);
  dlg.showModal();
  const section = (title, ...kids) => h('section', { class: 'drawer-section' }, h('h3', {}, title), ...kids);

  async function refresh() {
    clearTimeout(offsiteTimer);
    let o;
    try { o = await api(`/projects/${ref}/offsite`); } catch (e) { body.replaceChildren(h('p', { class: 'error' }, e.message)); return; }
    if (!dlg.isConnected) return;
    const scroll = body.scrollTop;
    body.replaceChildren(...[
      notice && h('div', { class: notice.error ? 'warn-note' : 'ok-note', role: 'status' }, notice.text),
      statusSection(o), destinationsSection(o), scheduleSection(o), runsSection(o)].filter(Boolean));
    notice = null;
    body.scrollTop = scroll;
    if (o.running || o.runs.some((r) => r.status === 'running')) offsiteTimer = setTimeout(refresh, 3000);
  }

  function statusSection(o) {
    const enabled = o.destinations.filter((d) => d.enabled);
    const last = o.runs[0];
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: !enabled.length || o.running || p?.status !== 'ready', onclick: async () => {
      btn.disabled = true;
      try { await api(`/projects/${ref}/offsite/run`, { method: 'POST', body: {} }); toast('Offsite backup started'); }
      catch (e) { toast(e.message); }
      refresh();
    } }, o.running ? 'Backing up…' : 'Back up now');
    return section('Copies outside this server',
      h('p', { class: 'muted' }, `The database${o.settings.includeFiles ? ' and uploaded files' : ''} are copied to your own storage on a schedule, so a lost server never means lost data. Old copies are removed after ${o.settings.retentionDays} days.`),
      h('div', { class: 'row spread' },
        h('div', { class: 'muted small' },
          enabled.length ? [`Next backup: ${fmtWhen(o.nextRunAt)}`, h('br'), last ? ['Last: ', fmtWhen(last.startedAt), ' · ', runPill(last.status)] : 'No offsite backup yet.'] : 'Add a destination to start.'),
        h('div', { class: 'row' }, o.running && h('span', { class: 'spinner' }), btn)));
  }

  function destinationsSection(o) {
    const lastTarget = (id) => o.runs.flatMap((r) => r.targets.map((t) => ({ ...t, at: r.startedAt }))).find((t) => t.destinationId === id && t.status !== 'running');
    const rows = o.destinations.map((d) => {
      const c = d.config;
      const detail = d.type === 's3'
        ? `${c.bucket}${c.prefix ? `/${c.prefix}` : ''} · ${c.endpoint.replace(/^https?:\/\//, '')}`
        : `Folder “${c.folderName}”${c.account ? ` · ${c.account}` : ''}`;
      const t = lastTarget(d.id);
      const testBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
        testBtn.disabled = true; testBtn.textContent = 'Testing…';
        try {
          const r = await api(`/projects/${ref}/offsite/destinations/${d.id}/test`, { method: 'POST', body: {} });
          toast(r.ok ? `${d.label}: connection works` : `${d.label}: ${r.error}`);
        } catch (e) { toast(e.message); }
        testBtn.disabled = false; testBtn.textContent = 'Test';
      } }, 'Test');
      const actions = [
        d.type === 's3' ? menuItem('Edit', { onclick: () => s3Dialog(o, d) }) : menuItem('Reconnect / change folder', { onclick: () => driveDialog(o, d) }),
        menuItem(d.enabled ? 'Pause uploads' : 'Resume uploads', { onclick: async () => {
          try { await api(`/projects/${ref}/offsite/destinations/${d.id}`, { method: 'PATCH', body: { enabled: !d.enabled } }); } catch (e) { toast(e.message); }
          refresh();
        } }),
        h('div', { class: 'menu-sep' }),
        menuItem('Remove', { danger: true, onclick: async () => {
          if (!confirm(`Remove ${d.label}? Backups already stored there are kept.`)) return;
          try { await api(`/projects/${ref}/offsite/destinations/${d.id}`, { method: 'DELETE' }); toast(`${d.label} removed`); } catch (e) { toast(e.message); }
          refresh();
        } }),
      ];
      return h('div', { class: `dest-row${d.enabled ? '' : ' paused'}` },
        h('div', { class: 'grow' },
          h('div', { class: 'row', style: 'gap:8px' }, h('strong', {}, d.label), h('span', { class: 'tag' }, d.type === 's3' ? 'S3' : 'Google Drive'), !d.enabled && h('span', { class: 'tag' }, 'Paused')),
          h('div', { class: 'muted small mono dest-detail' }, detail),
          t && h('div', { class: 'small' }, runPill(t.status), ' ', h('span', { class: 'muted' }, t.status === 'ok' ? `${fmtBytes(t.bytes)} · ${fmtDuration(t.durationMs)} · ${fmtWhen(t.at)}` : t.error || ''))),
        h('div', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, testBtn, dropdown(icon('more'), actions, { align: 'right', label: `${d.label} actions` })));
    });
    const full = o.destinations.length >= o.maxDestinations;
    return section('Destinations',
      rows.length ? rows : h('p', { class: 'muted' }, 'No destinations yet. Connect Google Drive or any S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO).'),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn small', type: 'button', disabled: full || !o.googleDrive.configured, onclick: () => driveDialog(o), title: o.googleDrive.configured ? undefined : 'Not configured on this server' }, icon('plus', 14), 'Google Drive'),
        h('button', { class: 'btn small', type: 'button', disabled: full, onclick: () => s3Dialog(o) }, icon('plus', 14), 'S3-compatible storage')),
      !o.googleDrive.configured && h('p', { class: 'muted small' }, 'Google Drive is not configured on this server (the operator sets GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET).'));
  }

  function scheduleSection(o) {
    const chosen = new Set(o.settings.hours);
    const hint = h('p', { class: 'muted small' });
    const updateHint = () => {
      const hours = [...chosen].sort((a, b) => a - b);
      hint.textContent = hours.length
        ? `Every day at ${hours.map((x) => `${pad2(x)}:00`).join(', ')} UTC — ${hours.map(localHour).join(', ')} your time.`
        : 'Pick at least one hour.';
    };
    const grid = h('div', { class: 'hour-grid', role: 'group', 'aria-label': 'Backup hours (UTC)' },
      Array.from({ length: 24 }, (_, hr) => {
        const b = h('button', { type: 'button', class: `hour${chosen.has(hr) ? ' on' : ''}`, 'aria-pressed': String(chosen.has(hr)), title: `${localHour(hr)} your time` }, pad2(hr));
        b.addEventListener('click', () => {
          chosen.has(hr) ? chosen.delete(hr) : chosen.add(hr);
          b.classList.toggle('on', chosen.has(hr)); b.setAttribute('aria-pressed', String(chosen.has(hr))); updateHint();
        });
        return b;
      }));
    updateHint();
    const days = h('input', { type: 'number', id: 'off-days', min: 1, max: 3650, value: o.settings.retentionDays, required: true });
    const files = h('input', { type: 'checkbox', id: 'off-files', checked: o.settings.includeFiles });
    const err = h('div', { class: 'error', role: 'alert' });
    const save = h('button', { class: 'btn small primary', type: 'submit' }, 'Save schedule');
    return section('Schedule',
      h('form', { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; save.disabled = true;
        try {
          await api(`/projects/${ref}/offsite/settings`, { method: 'PUT', body: { hours: [...chosen].sort((a, b) => a - b), retentionDays: Number(days.value), includeFiles: files.checked } });
          toast('Schedule saved'); refresh();
        } catch (ex) { err.textContent = ex.message; } finally { save.disabled = false; }
      } },
        h('div', { class: 'k muted small', style: 'margin-bottom:6px' }, 'Hours (UTC) — default 03:00 and 15:00'),
        grid, hint,
        h('div', { class: 'grid2' },
          h('div', {}, h('label', { for: 'off-days' }, 'Keep backups for (days)'), days),
          h('div', {}, h('label', { class: 'check', for: 'off-files', style: 'margin-top:40px' }, files, 'Include uploaded files'))),
        err,
        h('div', { class: 'row end', style: 'margin-top:4px' }, save)));
  }

  function runsSection(o) {
    if (!o.runs.length) return section('Recent backups', h('p', { class: 'muted' }, 'Nothing yet. Runs and their result for each destination show up here.'));
    return section('Recent backups',
      h('div', { class: 'run-list' }, o.runs.map((r) => h('div', { class: 'run' },
        h('div', { class: 'row spread' },
          h('div', {}, h('strong', {}, fmtWhen(r.startedAt)), h('span', { class: 'muted small' }, ` · ${r.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}`)),
          runPill(r.status)),
        r.artifacts.length > 0 && h('div', { class: 'muted small' }, r.artifacts.map((a) => `${a.name} ${fmtBytes(a.size)}`).join(' · ')),
        r.error && r.status === 'failed' && !r.targets.some((t) => t.status === 'ok') && h('div', { class: 'small err-text' }, r.error),
        h('ul', { class: 'run-targets' }, r.targets.map((t) => h('li', {},
          runPill(t.status), ' ', h('span', {}, t.label),
          t.status === 'ok' && h('span', { class: 'muted' }, ` · ${fmtBytes(t.bytes)} in ${fmtDuration(t.durationMs)}`),
          t.error && h('div', { class: 'small err-text' }, t.error),
          t.note && h('div', { class: 'muted small' }, t.note))))))));
  }

  // ---- add / edit S3 destination
  function s3Dialog(o, existing) {
    const c = existing?.config || {};
    const err = h('div', { class: 'error', role: 'alert' });
    const f = (id, label, input, hint) => h('div', {}, h('label', { for: id }, label), input, hint && h('div', { class: 'muted small', style: 'margin-top:4px' }, hint));
    const provider = h('select', { id: 's3-provider' }, Object.entries(S3_PRESETS).map(([k, v]) => h('option', { value: k }, v.name)));
    const providerHint = h('div', { class: 'muted small', style: 'margin-top:4px' });
    const lbl = h('input', { type: 'text', id: 's3-label', maxlength: 40, required: true, value: existing?.label || '' });
    const endpoint = h('input', { type: 'text', id: 's3-endpoint', required: true, value: c.endpoint || '', spellcheck: 'false', autocomplete: 'off' });
    const region = h('input', { type: 'text', id: 's3-region', value: c.region ?? '', spellcheck: 'false', autocomplete: 'off' });
    const bucket = h('input', { type: 'text', id: 's3-bucket', required: true, value: c.bucket || '', spellcheck: 'false', autocomplete: 'off' });
    const prefix = h('input', { type: 'text', id: 's3-prefix', value: c.prefix || '', placeholder: 'optional, e.g. backups/', spellcheck: 'false', autocomplete: 'off' });
    const keyId = h('input', { type: 'text', id: 's3-key', required: !existing, autocomplete: 'off', spellcheck: 'false', placeholder: existing ? `Saved (${c.accessKeyId}) — leave empty to keep` : '' });
    const secret = h('input', { type: 'password', id: 's3-secret', required: !existing, autocomplete: 'new-password', placeholder: existing ? 'Saved — leave empty to keep' : '' });
    const pathStyle = h('input', { type: 'checkbox', id: 's3-path', checked: !!c.pathStyle });
    const enabled = h('input', { type: 'checkbox', id: 's3-enabled', checked: existing ? existing.enabled : true });
    const applyPreset = (initial) => {
      const pr = S3_PRESETS[provider.value];
      providerHint.textContent = pr.hint;
      endpoint.placeholder = pr.endpoint; region.placeholder = pr.region;
      if (!initial) { pathStyle.checked = pr.pathStyle; if (!region.value) region.value = pr.region; if (!lbl.value) lbl.value = pr.name; }
    };
    provider.addEventListener('change', () => applyPreset(false));
    if (!existing) applyPreset(false); else applyPreset(true);
    const save = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save and test' : 'Add and test');
    const dlg = h('dialog', { onclose: () => dlg.remove() }, h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; save.disabled = true;
      const config = { endpoint: endpoint.value.trim(), region: region.value.trim(), bucket: bucket.value.trim(), prefix: prefix.value.trim(), pathStyle: pathStyle.checked };
      if (keyId.value.trim() || !existing) config.accessKeyId = keyId.value.trim();
      if (secret.value || !existing) config.secretAccessKey = secret.value;
      try {
        const { destination } = existing
          ? await api(`/projects/${ref}/offsite/destinations/${existing.id}`, { method: 'PATCH', body: { label: lbl.value.trim(), enabled: enabled.checked, config } })
          : await api(`/projects/${ref}/offsite/destinations`, { method: 'POST', body: { type: 's3', label: lbl.value.trim(), enabled: enabled.checked, config } });
        save.textContent = 'Testing…';
        const t = await api(`/projects/${ref}/offsite/destinations/${destination.id}/test`, { method: 'POST', body: {} });
        dlg.close();
        notice = t.ok ? { text: `${destination.label} saved. A test file was written and removed.` } : { error: true, text: `${destination.label} saved, but the connection test failed: ${t.error}` };
        refresh();
      } catch (ex) { err.textContent = ex.message; save.textContent = existing ? 'Save and test' : 'Add and test'; } finally { save.disabled = false; }
    } },
      h('h2', {}, existing ? `Edit ${existing.label}` : 'Add S3-compatible storage'),
      !existing && f('s3-provider', 'Provider', provider), providerHint,
      f('s3-label', 'Name', lbl),
      f('s3-endpoint', 'Endpoint URL', endpoint),
      h('div', { class: 'grid2' }, f('s3-bucket', 'Bucket', bucket), f('s3-region', 'Region', region)),
      f('s3-prefix', 'Folder prefix', prefix, 'Backups go to <prefix>/mojobase/<project>-<ref>/<date>/'),
      f('s3-key', 'Access key ID', keyId),
      f('s3-secret', 'Secret access key', secret, 'Stored encrypted and never shown again. Use a key limited to this bucket.'),
      h('label', { class: 'check', for: 's3-path' }, pathStyle, 'Path-style URLs (MinIO, R2)'),
      h('label', { class: 'check', for: 's3-enabled', style: 'margin-top:6px' }, enabled, 'Upload to this destination'),
      err,
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), save)));
    document.body.append(dlg);
    dlg.showModal();
  }

  // ---- connect / reconnect Google Drive
  function driveDialog(o, existing) {
    if (!o.googleDrive.configured) return toast('Google Drive is not configured on this server');
    const err = h('div', { class: 'error', role: 'alert' });
    const lbl = h('input', { type: 'text', id: 'gd-label', maxlength: 40, required: true, value: existing?.label || 'Google Drive' });
    const folder = h('input', { type: 'text', id: 'gd-folder', maxlength: 80, required: true, value: existing?.config.folderName || 'Mojobase Backups' });
    const cont = h('button', { class: 'btn primary', type: 'submit' }, 'Continue to Google');
    const dlg = h('dialog', { onclose: () => dlg.remove() }, h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; cont.disabled = true;
      try {
        const { url } = await api(`/projects/${ref}/offsite/gdrive/connect`, { method: 'POST', body: { label: lbl.value.trim(), folderName: folder.value.trim(), ...(existing ? { destinationId: existing.id } : {}) } });
        location.assign(url);
      } catch (ex) { err.textContent = ex.message; cont.disabled = false; }
    } },
      h('h2', {}, existing ? 'Reconnect Google Drive' : 'Connect Google Drive'),
      h('p', { class: 'muted' }, 'Mojobase only gets access to the files it creates — not the rest of your Drive. Backups go into a folder in My Drive.'),
      !existing && [h('label', { for: 'gd-label' }, 'Name'), lbl],
      h('label', { for: 'gd-folder' }, 'Folder name'), folder,
      err,
      h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), cont)));
    document.body.append(dlg);
    dlg.showModal();
  }

  refresh();
}

// ---------------------------------------------------------------- router
async function render() {
  clearTimeout(pollTimer);
  const path = location.pathname;
  try {
    if (me === null) {
      const r = await api('/me');
      me = r.user ? { ...r.user, limits: r.limits, requireVerifiedEmail: r.requireVerifiedEmail } : null;
    }
    // Pages reached from email links work whether or not you are signed in.
    if (path === '/verify' || path === '/reset-password' || (path === '/forgot-password' && !me)) {
      $shell.classList.add('signed-out'); $top.replaceChildren(); $side.replaceChildren();
      $app.replaceChildren(path === '/verify' ? await verifyPage() : path === '/reset-password' ? resetPage() : forgotPage());
      return;
    }
    if (!me) {
      renderTopbar(null); renderSidebar(null);
      $app.replaceChildren(authPage(path === '/login' ? 'login' : 'signup'));
      if (path !== '/login' && path !== '/signup') history.replaceState({}, '', '/signup');
      return;
    }
    if (path === '/login' || path === '/signup') history.replaceState({}, '', '/');
    projectsCache = (await api('/projects')).projects;
    const m = location.pathname.match(/^\/projects\/([a-z0-9]+)(\/.*)?$/);
    if (m) {
      const p = projectFor(m[1]);
      // Back from Google Drive consent (or a failure email): open the offsite drawer.
      const params = new URLSearchParams(location.search);
      if (p && params.has('offsite')) {
        const kind = params.get('offsite');
        const notice = kind === 'connected' ? { text: 'Google Drive connected. Backups will be uploaded on the next run.' }
          : kind === 'error' ? { error: true, text: params.get('message') || 'Google Drive could not be connected.' } : undefined;
        history.replaceState({}, '', location.pathname);
        setTimeout(() => openOffsite(m[1], { notice }), 0);
      }
      $shell.classList.add('project-mode');
      renderTopbar(p); renderSidebar('project');
      const view = projectPage(m[1], m[2]);
      if (view) $app.replaceChildren(view);
      lastPath = location.pathname;
      return;
    }
    bridge.ref = null; bridge.frame = null;
    $shell.classList.remove('project-mode');
    const section = { '/usage': 'usage', '/agents': 'agents', '/settings': 'settings', '/account': 'settings' }[path] || 'projects';
    renderTopbar(null); renderSidebar(section);
    $side.classList.remove('open');
    $app.replaceChildren({ usage: usagePage, agents: agentsPage, settings: accountPage }[section]?.() ?? projectsPage());
    if (lastPath !== path) window.scrollTo(0, 0);
    lastPath = path;
  } catch (e) {
    if (e.status === 401) { me = null; return render(); }
    $app.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message),
      h('a', { href: '/', 'data-link': true }, 'Back to projects'))));
  }
}
render();
