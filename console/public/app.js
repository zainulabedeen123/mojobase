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
const DOCS_URL = 'https://github.com/zainulabedeen123/mojobase#readme';
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
    h('a', { href: '/', 'data-link': true, class: 'crumb' }, h('span', { class: 'org-avatar' }, 'P'), h('span', { class: 'crumb-label' }, 'Personal'), h('span', { class: 'plan' }, 'Free')),
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
function authPage(mode) {
  const isSignup = mode === 'signup';
  const err = h('div', { class: 'error', role: 'alert' });
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: isSignup ? 'new-password' : 'current-password', required: true, minlength: isSignup ? 10 : undefined });
  const submit = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center;margin-top:18px' }, isSignup ? 'Create account' : 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try {
        const { user } = await api(isSignup ? '/signup' : '/login', { method: 'POST', body: { email: email.value, password: pw.value } });
        void user; me = null; go('/');
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    },
  },
    h('label', { for: 'email' }, 'Email'), email,
    h('label', { for: 'pw' }, 'Password'), pw,
    isSignup && h('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' }, 'At least 10 characters.'),
    !isSignup && h('div', { style: 'text-align:right;margin-top:8px;font-size:13px' }, h('a', { href: '/forgot-password', 'data-link': true }, 'Forgot password?')),
    submit, err,
  );
  return h('div', { class: 'auth' },
    h('img', { src: '/favicon.svg', alt: '', class: 'hero-mark' }),
    h('h1', {}, isSignup ? 'Create your Mojobase account' : 'Sign in to Mojobase'),
    h('p', { class: 'sub' }, 'Postgres, auth, storage, edge functions and realtime — a backend for every project.'),
    h('div', { class: 'card' }, form),
    h('div', { class: 'switch' }, isSignup ? 'Already have an account? ' : 'New to Mojobase? ',
      h('a', { href: isSignup ? '/login' : '/signup', 'data-link': true }, isSignup ? 'Sign in' : 'Create an account')),
  );
}

function newProjectDialog() {
  const err = h('div', { class: 'error', role: 'alert' });
  const name = h('input', { type: 'text', id: 'pname', maxlength: 40, required: true, placeholder: 'my-app' });
  const create = h('button', { class: 'btn primary', type: 'submit' }, 'Create project');
  const dlg = h('dialog', {},
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; create.disabled = true;
        try { const { project } = await api('/projects', { method: 'POST', body: { name: name.value } }); dlg.close(); go(`/projects/${project.ref}`); }
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
    'JavaScript SDK': `npm install @insforge/sdk

import { createClient } from '@insforge/sdk';

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
  return h('div', { class: 'auth' }, h('img', { src: '/favicon.svg', alt: '', class: 'hero-mark' }), h('h1', {}, title), h('div', { class: 'card' }, ...children));
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
  const email = h('input', { type: 'email', id: 'email', autocomplete: 'email', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center;margin-top:18px' }, 'Send reset link');
  const box = h('div', {});
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    try {
      await api('/forgot-password', { method: 'POST', body: { email: email.value } });
      box.replaceChildren(h('p', {}, `If an account exists for ${email.value}, a reset link is on its way. It expires in 1 hour.`),
        h('a', { href: '/login', 'data-link': true }, 'Back to sign in'));
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  } }, h('label', { for: 'email' }, 'Email'), email, btn, err);
  box.append(form, h('div', { class: 'switch' }, h('a', { href: '/login', 'data-link': true }, 'Back to sign in')));
  return simpleCard('Reset your password', box);
}

function resetPage() {
  const token = new URLSearchParams(location.search).get('token');
  const err = h('div', { class: 'error', role: 'alert' });
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'new-password', required: true, minlength: 10 });
  const btn = h('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center;margin-top:18px' }, 'Set new password');
  return simpleCard('Choose a new password', h('form', { onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.textContent = '';
    try {
      await api('/reset-password', { method: 'POST', body: { token, password: pw.value } });
      me = null; toast('Password changed'); go('/');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  } }, h('label', { for: 'pw' }, 'New password'), pw,
    h('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' }, 'At least 10 characters. You will be signed out everywhere else.'), btn, err));
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
      h('div', { class: 'grid2' }, copyField('Name', 'Personal'), copyField('Plan', 'Free')),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Team members and paid plans are coming later. Every project is free while Mojobase is in preview.')),
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
  const limit = me.limits?.perUser ?? 2;
  const needsVerify = me.requireVerifiedEmail && !me.emailVerified;
  const atLimit = projects.length >= limit;
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
  const newBtn = h('button', { class: 'btn primary', type: 'button', disabled: atLimit || needsVerify, title: atLimit ? `The Free plan includes ${limit} projects` : needsVerify ? 'Confirm your email first' : undefined, onclick: () => dlg.showModal() }, icon('plus', 15), 'New Project');
  if (BUSY_ANY()) pollTimer = setTimeout(render, 4000);
  return h('div', { class: 'page' },
    needsVerify && verifyBanner(),
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub' }, `${projects.length} of ${limit} projects on the Free plan`))),
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

// ---------------------------------------------------------------- usage
function usagePage() {
  const limit = me.limits?.perUser ?? 2;
  const sum = (k) => projectsCache.reduce((n, p) => n + (p.usage?.[k] || 0), 0);
  const tile = (label, value, hint) => h('div', { class: 'tile' }, h('div', { class: 'k' }, label), h('div', { class: 'big' }, value), hint && h('div', { class: 'muted small' }, hint));
  return h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Usage'), h('p', { class: 'sub' }, 'Resources used by the projects in your organization. Sizes refresh every few minutes.'))),
    h('div', { class: 'tiles' },
      tile('Projects', `${projectsCache.length} / ${limit}`, 'Free plan'),
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
    provisioning: ['Setting up your backend…', 'Creating the Postgres database, auth, storage and functions. This takes about a minute.'],
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
    case 'OPEN_WHATS_NEW': return void window.open('https://github.com/zainulabedeen123/mojobase/commits/main', '_blank', 'noopener');
    case 'SHOW_UPGRADE_DIALOG': return toast('Paid plans are not available yet — everything on Mojobase is free for now.');
    default:
      if (/POSTHOG|APIFY/.test(msg.type) && /^(OPEN|CONNECT|REQUEST)/.test(msg.type))
        sendToFrame({ type: msg.type.includes('POSTHOG') ? 'POSTHOG_CONNECTION_STATUS' : 'APIFY_CONNECTION_STATUS', status: 'error', reason: 'This integration is not available on Mojobase yet.', timestamp: Date.now() });
  }
});

// ---------------------------------------------------------------- Connect drawer
async function openConnect(ref) {
  const { project: p } = await api(`/projects/${ref}`);
  if (!p.database) return toast('Connection details appear once the project is active.');
  const db = p.database;
  const section = (title, ...kids) => h('section', { class: 'drawer-section' }, h('h3', {}, title), ...kids);
  const dlg = h('dialog', { class: 'drawer', onclose: () => dlg.remove() },
    h('div', { class: 'drawer-head' }, h('h2', {}, `Connect to ${p.name}`), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 18))),
    h('div', { class: 'drawer-body' },
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
