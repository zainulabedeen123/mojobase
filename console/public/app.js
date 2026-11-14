// Mojobase console — a small dependency-free SPA. All user data is inserted
// with textContent (never innerHTML) so nothing a user types can run as markup.
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
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
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
});

function renderNav() {
  $nav.replaceChildren(
    ...(me
      ? [h('span', { class: 'muted' }, me.email), h('button', { class: 'btn small', onclick: logout }, 'Sign out')]
      : [])
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
        me = user; go('/');
      } catch (ex) { err.textContent = ex.message; } finally { submit.disabled = false; }
    },
  },
    h('label', { for: 'email' }, 'Email'), email,
    h('label', { for: 'pw' }, 'Password'), pw,
    isSignup && h('div', { class: 'muted', style: 'font-size:13px;margin-top:6px' }, 'At least 10 characters.'),
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
  return h('div', {},
    h('div', { class: 'row spread', style: 'margin-bottom:20px' },
      h('div', {}, h('h1', {}, 'Projects'), h('p', { class: 'sub', style: 'margin:0' }, `${projects.length} of ${limit} projects`)),
      h('button', { class: 'btn primary', disabled: atLimit, title: atLimit ? `You can have up to ${limit} projects` : undefined, onclick: () => dlg.showModal() }, '+ New project'),
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
          h('button', { class: 'btn primary', onclick: () => dlg.showModal() }, '+ New project')),
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
    h('div', { class: 'card' },
      h('h2', {}, 'Connect your app'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Use the SDK or REST API from your app, or connect straight to Postgres with the connection string (Prisma, Drizzle, psql, TablePlus…).'),
      snippets(p)),
    h('div', { class: 'card' },
      h('h2', {}, 'API'),
      copyField('Project URL', p.apiUrl),
      copyField('Anon key (safe for browsers and apps)', p.anonKey),
      copyField('API key (secret — server-side only, full admin access)', p.apiKey, { secret: true })),
    h('div', { class: 'card' },
      h('h2', {}, 'Database'),
      copyField('Connection string', db.connectionString, { secret: true, display: db.connectionString }),
      h('div', { class: 'grid' },
        copyField('Host', db.host), copyField('Port', String(db.port)),
        copyField('Database', db.database), copyField('User', db.user),
        copyField('Password', db.password, { secret: true })),
      h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, 'TLS is required (sslmode=require). The connection uses a project admin role: full access to your tables, no server superuser.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Project dashboard'),
      h('p', { class: 'muted', style: 'margin-top:-6px' }, 'Tables, auth users, storage, functions, logs and SQL editor for this project.'),
      h('div', { class: 'grid' }, copyField('Username', p.dashboard.username), copyField('Password', p.dashboard.password, { secret: true })),
      h('a', { class: 'btn primary', href: p.dashboardUrl, target: '_blank', rel: 'noopener' }, 'Open dashboard ↗')),
    h('div', { class: 'card' },
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

// ---------------------------------------------------------------- router
async function render() {
  clearTimeout(pollTimer);
  const path = location.pathname;
  try {
    if (me === null) {
      const r = await api('/me');
      me = r.user ? { ...r.user, limits: r.limits } : null;
    }
    renderNav();
    if (!me) {
      $app.replaceChildren(authPage(path === '/login' ? 'login' : 'signup'));
      if (path !== '/login' && path !== '/signup') history.replaceState({}, '', '/signup');
      return;
    }
    const m = path.match(/^\/projects\/([a-z0-9]+)$/);
    $app.replaceChildren(m ? await projectPage(m[1]) : await projectsPage());
    if (path === '/login' || path === '/signup') history.replaceState({}, '', '/');
  } catch (e) {
    if (e.status === 401) { me = null; return render(); }
    $app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Something went wrong'), h('p', { class: 'muted' }, e.message),
      h('a', { href: '/', 'data-link': true }, 'Back to projects')));
  }
}
render();
