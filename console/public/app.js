// Mojobase console — a small dependency-free SPA. All user data is inserted
// with textContent (never innerHTML) so nothing a user types can run as markup.
const $app = document.getElementById('app');
const $side = document.getElementById('sidebar');
const $shell = document.getElementById('shell');
let sideProjects = [];
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
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
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
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}
function go(path) { history.pushState({}, '', path); render(); }
window.addEventListener('popstate', render);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const url = new URL(a.getAttribute('href'), location.origin);
    if (url.pathname === location.pathname && url.hash) {
      history.pushState({}, '', url.pathname + url.hash);
      document.getElementById(url.hash.slice(1))?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      $side.classList.remove('open');
      renderSidebar();
      return;
    }
    go(url.pathname + url.hash);
  }
});

// ---------------------------------------------------------------- sidebar
const dot = (status) => h('span', { class: `dot ${status}`, title: status });
function navLink(href, label, { active = false, external = false, icon = '' } = {}) {
  return h('a', {
    href, class: `nav-item${active ? ' active' : ''}`,
    ...(external ? { target: '_blank', rel: 'noopener' } : { 'data-link': true }),
    'aria-current': active ? 'page' : undefined,
  }, icon && h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'nav-label' }, label), external && h('span', { class: 'nav-ext', 'aria-hidden': 'true' }, '↗'));
}
function renderSidebar() {
  $shell.classList.toggle('signed-out', !me);
  if (!me) { $side.replaceChildren(); return; }
  const path = location.pathname;
  const m = path.match(/^\/projects\/([a-z0-9]+)$/);
  const currentRef = m && m[1];
  const current = sideProjects.find((p) => p.ref === currentRef);
  const section = location.hash.slice(1);
  const menuBtn = h('button', { class: 'btn small menu-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'sidenav',
    onclick: () => { const open = $side.classList.toggle('open'); menuBtn.setAttribute('aria-expanded', String(open)); } }, 'Menu');
  $side.replaceChildren(
    h('div', { class: 'side-top' },
      h('a', { href: '/', 'data-link': true, class: 'brand', 'aria-label': 'Mojobase home' },
        h('img', { src: '/logo-dark.svg', alt: 'Mojobase', class: 'logo logo-dark' }),
        h('img', { src: '/logo-light.svg', alt: 'Mojobase', class: 'logo logo-light' })),
      menuBtn),
    h('nav', { id: 'sidenav', class: 'side-nav' },
      navLink('/', 'Projects', { active: path === '/', icon: '▦' }),
      sideProjects.length > 0 && h('div', { class: 'nav-group' },
        h('div', { class: 'nav-heading' }, 'Your projects'),
        sideProjects.map((p) => h('div', {},
          h('a', { href: `/projects/${p.ref}`, 'data-link': true, class: `nav-item project-item${p.ref === currentRef ? ' active' : ''}`, 'aria-current': p.ref === currentRef ? 'page' : undefined },
            dot(p.status), h('span', { class: 'nav-label' }, p.name)),
          p.ref === currentRef && current?.status === 'ready' && h('div', { class: 'nav-sub' },
            [['connect', 'Connect'], ['api', 'API keys'], ['database', 'Database'], ['backups', 'Backups'], ['dashboard', 'Dashboard'], ['danger', 'Settings']]
              .map(([id, label]) => navLink(`/projects/${p.ref}#${id}`, label, { active: section === id })),
            navLink(`${p.apiUrl}/dashboard`, 'Open dashboard', { external: true }))))),
      h('div', { class: 'nav-group' },
        h('div', { class: 'nav-heading' }, 'Account'),
        navLink('/account#mcp', 'AI agents (MCP)', { active: path === '/account' && section === 'mcp', icon: '✦' }),
        navLink('/account', 'Account', { active: path === '/account' && section !== 'mcp', icon: '◉' }),
        navLink('https://github.com/zainulabedeen123/mojobase#readme', 'Docs', { external: true, icon: '❐' }))),
    h('div', { class: 'side-user' },
      h('div', { class: 'side-email', title: me.email }, me.email),
      h('button', { class: 'btn small', type: 'button', onclick: logout }, 'Sign out')),
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

// ---------------------------------------------------------------- projects list
const badge = (status) => h('span', { class: `badge ${status}` }, { provisioning: 'Setting up', ready: 'Ready', failed: 'Failed', deleting: 'Deleting' }[status] || status);

async function projectsPage() {
  const { projects } = await api('/projects');
  const limit = me.limits?.perUser ?? 2;
  const dlg = newProjectDialog();
  const atLimit = projects.length >= limit;
  const needsVerify = me.requireVerifiedEmail && !me.emailVerified;
  return h('div', {},
    needsVerify && verifyBanner(),
    h('div', { class: 'row spread', style: 'margin-bottom:20px' },
      h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub', style: 'margin:0' }, `${projects.length} of ${limit} projects`)),
      h('button', { class: 'btn primary', disabled: atLimit || needsVerify, title: atLimit ? `You can have up to ${limit} projects` : undefined, onclick: () => dlg.showModal() }, '+ New project'),
    ),
    projects.length
      ? h('div', { class: 'grid' }, projects.map((p) =>
          h('a', { class: 'project', href: `/projects/${p.ref}`, 'data-link': true },
            h('div', { class: 'row spread' }, h('h3', {}, p.name), badge(p.status)),
            h('div', { class: 'muted', style: 'font-size:13px;font-family:var(--mono)' }, p.apiUrl.replace('https://', '')),
          )))
      : h('div', { class: 'card empty' },
          h('h2', {}, 'Create your first project'),
          h('p', { class: 'muted' }, 'Each project gets its own Postgres database, auth, storage, edge functions, realtime, API keys and a connection string.'),
          h('button', { class: 'btn primary', disabled: needsVerify, onclick: () => dlg.showModal() }, '+ New project')),
    dlg,
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

// ---------------------------------------------------------------- project page
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

async function projectPage(ref) {
  const { project: p } = await api(`/projects/${ref}`);
  const header = h('div', { style: 'margin-bottom:20px' },
    h('a', { href: '/', 'data-link': true, class: 'muted', style: 'font-size:14px;text-decoration:none' }, '← All projects'),
    h('div', { class: 'row', style: 'margin-top:8px' }, h('h1', {}, p.name), badge(p.status)),
    h('div', { class: 'muted', style: 'font-family:var(--mono);font-size:13px' }, `ref ${p.ref}`));

  if (p.status === 'provisioning' || p.status === 'deleting') {
    pollTimer = setTimeout(render, 3000);
    return h('div', {}, header, h('div', { class: 'card progress' }, h('span', { class: 'spinner' }),
      h('div', {}, h('strong', {}, p.status === 'deleting' ? 'Deleting project…' : 'Setting up your backend…'),
        h('div', { class: 'muted' }, p.status === 'deleting' ? 'Removing the database, files and functions.' : 'Creating the Postgres database, auth, storage and functions. This takes about a minute.'))));
  }
  if (p.status === 'failed') {
    return h('div', {}, header, h('div', { class: 'card' },
      h('h2', {}, 'Setup failed'), h('pre', { class: 'snippet' }, p.error || 'Unknown error'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => { await api(`/projects/${ref}/retry`, { method: 'POST', body: {} }); render(); } }, 'Try again'),
        deleteButton(p))));
  }

  const db = p.database;
  return h('div', {}, header,
    h('div', { class: 'card', id: 'connect' },
      h('h2', {}, 'Connect your app'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Use the SDK or REST API from your app, or connect straight to Postgres with the connection string (Prisma, Drizzle, psql, TablePlus…).'),
      snippets(p)),
    h('div', { class: 'card', id: 'api' },
      h('h2', {}, 'API'),
      copyField('Project URL', p.apiUrl),
      copyField('Anon key (safe for browsers and apps)', p.anonKey),
      copyField('API key (secret — server-side only, full admin access)', p.apiKey, { secret: true })),
    h('div', { class: 'card', id: 'database' },
      h('h2', {}, 'Database'),
      copyField('Connection string', db.connectionString, { secret: true, display: db.connectionString }),
      h('div', { class: 'grid' },
        copyField('Host', db.host), copyField('Port', String(db.port)),
        copyField('Database', db.database), copyField('User', db.user),
        copyField('Password', db.password, { secret: true })),
      h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'TLS is required (sslmode=require). The connection uses a project admin role: full access to your tables, no server superuser.')),
    h('div', { class: 'card', id: 'dashboard' },
      h('h2', {}, 'Project dashboard'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Tables, auth users, storage, functions, logs and SQL editor for this project.'),
      h('div', { class: 'grid' }, copyField('Username', p.dashboard.username), copyField('Password', p.dashboard.password, { secret: true })),
      h('a', { class: 'btn primary', href: p.dashboardUrl, target: '_blank', rel: 'noopener' }, 'Open dashboard ↗')),
    backupsCard(p),
    h('div', { class: 'card', id: 'danger' },
      h('h2', {}, 'Danger zone'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Deleting a project permanently removes its database, users, files and functions.'),
      deleteButton(p)));
}

function deleteButton(p) {
  const err = h('div', { class: 'error' });
  const input = h('input', { type: 'text', id: 'confirm', autocomplete: 'off' });
  const confirmBtn = h('button', { class: 'btn danger', type: 'submit' }, 'Delete forever');
  const dlg = h('dialog', {}, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (input.value !== p.name) { err.textContent = 'Type the project name exactly to confirm.'; return; }
      confirmBtn.disabled = true;
      try { await api(`/projects/${p.ref}`, { method: 'DELETE' }); dlg.close(); render(); } catch (ex) { err.textContent = ex.message; confirmBtn.disabled = false; }
    },
  },
    h('h2', {}, `Delete ${p.name}?`),
    h('p', { class: 'muted' }, 'This permanently deletes the database, users, files and functions. It cannot be undone.'),
    h('label', { for: 'confirm' }, `Type "${p.name}" to confirm`), input, err,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), confirmBtn)));
  return h('span', {}, h('button', { class: 'btn danger', type: 'button', onclick: () => dlg.showModal() }, 'Delete project'), dlg);
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
  return h('div', {},
    h('a', { href: '/', 'data-link': true, class: 'muted', style: 'font-size:14px;text-decoration:none' }, '← All projects'),
    h('h1', { style: 'margin-top:8px' }, 'Account'),
    h('div', { class: 'card' },
      copyField('Email', me.email),
      h('p', { class: 'muted', style: 'margin:0' }, me.emailVerified ? 'Email confirmed.' : 'Email not confirmed yet.'),
      h('div', { class: 'row', style: 'margin-top:14px' }, h('a', { class: 'btn', href: '/forgot-password', 'data-link': true, onclick: async (e) => {
        e.preventDefault();
        await api('/forgot-password', { method: 'POST', body: { email: me.email } });
        toast('Password reset link sent to your email');
      } }, 'Change password'))),
    mcpCard(),
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
    h('h2', {}, 'AI agents (MCP)'),
    h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Connect Claude Code, Cursor, Windsurf, VS Code or any MCP client to Mojobase. Agents can create projects, run SQL, manage storage and functions, and get your connection details. A token has the same access as your account — revoke it any time.'),
    copyField('MCP server URL', MCP_URL),
    form, err, created,
    h('div', { class: 'k', style: 'font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 6px' }, 'Your tokens'),
    list);
}

// ---------------------------------------------------------------- backups
function fmtBytes(n) { return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
function backupsCard(p) {
  const list = h('div', {}, h('span', { class: 'spinner' }));
  const load = async () => {
    const { backups, keep, hourUtc } = await api(`/projects/${p.ref}/backups`);
    list.replaceChildren(
      h('p', { class: 'muted', style: 'margin-top:-6px' }, `Automatic database backup every night at ${String(hourUtc).padStart(2, '0')}:00 UTC. The newest ${keep} are kept.`),
      backups.length
        ? h('div', {}, backups.map((b) => h('div', { class: 'copy', style: 'margin-bottom:8px' },
            h('code', {}, `${new Date(b.createdAt).toLocaleString()} · ${fmtBytes(b.size)}`),
            h('a', { class: 'btn small', href: `/api/projects/${p.ref}/backups/${b.file}`, download: b.file }, 'Download'))))
        : h('p', { class: 'muted' }, 'No backups yet.'));
  };
  const btn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    btn.disabled = true; btn.textContent = 'Backing up…';
    try { await api(`/projects/${p.ref}/backups`, { method: 'POST', body: {} }); toast('Backup created'); await load(); }
    catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = 'Back up now'; }
  } }, 'Back up now');
  load().catch((e) => list.replaceChildren(h('p', { class: 'error' }, e.message)));
  return h('div', { class: 'card', id: 'backups' },
    h('div', { class: 'row spread' }, h('h2', { style: 'margin:0' }, 'Backups'), btn),
    h('div', { style: 'margin-top:12px' }, list),
    h('p', { class: 'muted', style: 'font-size:13px;margin:8px 0 0' }, 'Backups are PostgreSQL custom-format dumps (pg_restore). Uploaded files in storage are not included yet.'));
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
    if (me) sideProjects = (await api('/projects')).projects;
    renderSidebar();
    // Pages reached from email links work whether or not you are signed in.
    if (path === '/verify') { $app.replaceChildren(await verifyPage()); return; }
    if (path === '/reset-password') { $app.replaceChildren(resetPage()); return; }
    if (path === '/forgot-password' && !me) { $app.replaceChildren(forgotPage()); return; }
    if (!me) {
      $app.replaceChildren(authPage(path === '/login' ? 'login' : 'signup'));
      if (path !== '/login' && path !== '/signup') history.replaceState({}, '', '/signup');
      return;
    }
    const m = path.match(/^\/projects\/([a-z0-9]+)$/);
    $app.replaceChildren(path === '/account' ? accountPage() : m ? await projectPage(m[1]) : await projectsPage());
    $side.classList.remove('open');
    const target = location.hash && document.getElementById(location.hash.slice(1));
    // Jump to #section links; otherwise start new pages at the top (but keep the
    // scroll position when the same page re-renders, e.g. while polling).
    if (target) target.scrollIntoView({ block: 'start' });
    else if (lastPath !== path) window.scrollTo(0, 0);
    lastPath = path;
    if (path === '/login' || path === '/signup') history.replaceState({}, '', '/');
  } catch (e) {
    if (e.status === 401) { me = null; return render(); }
    $app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message),
      h('a', { href: '/', 'data-link': true }, 'Back to projects')));
  }
}
render();
