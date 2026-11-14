// Mojobase MCP server (Streamable HTTP, stateless) at https://<console>/mcp.
// Authenticated with a personal access token (Authorization: Bearer mbp_...).
// Gives any MCP-capable agent the same powers as the token's owner: manage
// projects, read connection details, and work inside each project (SQL, tables,
// storage, functions, users, docs).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { projects, accessTokens } from './store.js';
import {
  projectView,
  ownedProject,
  createProject,
  deleteProject,
  projectApi,
  ServiceError,
} from './projects-service.js';
import { backupProject, listBackups } from './provisioner.js';
import { agentPrompt } from './agent-prompt.js';

const VERSION = '0.1.0';

const INSTRUCTIONS = `Mojobase is an open-source backend platform (Postgres database, auth, storage, edge functions, realtime). Each project is an isolated backend with its own URL, API keys and Postgres connection string. Mojobase is InsForge-compatible: apps use the @insforge/sdk package.

Typical workflow:
1. list_projects, or create_project to get a new backend (takes about a minute; it waits for you).
2. get_agent_prompt: complete integration instructions with every key filled in. Follow it to wire the project into the user's codebase. (get_integration_guide gives just the .env values and snippets.)
3. Design the schema with run_sql: CREATE TABLE ..., ENABLE ROW LEVEL SECURITY and policies using auth.uid(). Inspect with list_tables / get_table_schema.
4. Use create_bucket for file uploads and deploy_function for server-side code.
5. Read get_docs (topic "instructions" first) for exact SDK usage before writing app code.

Never put the API key or the database password in browser code: browsers use the anon key; the API key and connection string are server-side secrets.`;

const ref = z.string().describe('Project ref, e.g. "kq3v9xw2mtz7hb4r" (from list_projects)');
const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const text = (s) => ({ content: [{ type: 'text', text: s }] });

// Wraps a handler so service errors come back as tool errors the agent can read.
const tool =
  (fn) =>
  async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      const msg = e instanceof ServiceError ? e.message : `Unexpected error: ${e.message}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  };

async function waitUntilSettled(projectRef, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let p = projects.get(projectRef);
  while (p && p.status === 'provisioning' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    p = projects.get(projectRef);
  }
  return p;
}

function integrationGuide(p, stack) {
  const v = projectView(p, { withSecrets: true });
  const env = `# Public (safe in browser code)
NEXT_PUBLIC_MOJOBASE_URL=${v.apiUrl}
NEXT_PUBLIC_MOJOBASE_ANON_KEY=${v.anonKey}
# Server-side only (never expose to the browser)
MOJOBASE_API_KEY=${v.apiKey}
DATABASE_URL=${v.database.connectionString}`;
  const sdk = `npm install @insforge/sdk

import { createClient } from '@insforge/sdk';

export const mojobase = createClient({
  baseUrl: process.env.NEXT_PUBLIC_MOJOBASE_URL,
  anonKey: process.env.NEXT_PUBLIC_MOJOBASE_ANON_KEY,
});

// Database (PostgREST-style query builder; respects row-level security)
const { data, error } = await mojobase.database.from('todos').select('*').order('created_at');
await mojobase.database.from('todos').insert([{ title: 'Ship it' }]);

// Auth
await mojobase.auth.signUp({ email, password });
await mojobase.auth.signInWithPassword({ email, password });
const { data: { user } } = await mojobase.auth.getCurrentUser();

// Storage
await mojobase.storage.from('avatars').upload(\`\${user.id}/me.png\`, file);

// Edge functions
await mojobase.functions.invoke('hello', { body: { name: 'Ada' } });`;
  const snippets = {
    sdk,
    prisma: `// schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
// npx prisma db pull   (introspect)  /  npx prisma migrate deploy`,
    drizzle: `import { drizzle } from 'drizzle-orm/node-postgres';
export const db = drizzle(process.env.DATABASE_URL);`,
    psql: `psql "${v.database.connectionString}"`,
    rest: `curl '${v.apiUrl}/api/database/records/todos?select=*' -H 'Authorization: Bearer ${v.anonKey}'`,
  };
  const picked = stack && stack !== 'all' ? { [stack]: snippets[stack] ?? snippets.sdk } : snippets;
  return {
    project: { ref: v.ref, name: v.name, apiUrl: v.apiUrl, dashboardUrl: v.dashboardUrl },
    env,
    code: picked,
    notes: [
      'Use the anon key in browsers and mobile apps; row-level security decides what each user can do.',
      'The API key and DATABASE_URL have full access to the project: keep them server-side.',
      'DATABASE_URL requires TLS (sslmode=require) and connects as a project admin role (not a superuser).',
      'Tables need RLS policies and GRANTs to the "authenticated"/"anon" roles before the SDK can reach them.',
    ],
  };
}

export function buildServer(user) {
  const server = new McpServer(
    { name: 'mojobase', title: 'Mojobase', version: VERSION },
    { instructions: INSTRUCTIONS }
  );
  const reg = (name, cfg, fn) => server.registerTool(name, cfg, tool(fn));
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  // ------------------------------------------------------------ platform
  reg(
    'list_projects',
    {
      title: 'List projects',
      description: 'List your Mojobase projects with their status and API URL.',
      annotations: readOnly,
    },
    async () =>
      json({
        projects: projects.forOwner(user.id).map((p) => projectView(p, { withSecrets: false })),
      })
  );

  reg(
    'create_project',
    {
      title: 'Create project',
      description:
        'Create a new Mojobase project: its own Postgres database, auth, storage, edge functions and realtime. Waits until it is ready (about a minute) and returns its URL, keys and connection string.',
      inputSchema: {
        name: z
          .string()
          .describe('Project name, 1-40 letters, numbers, spaces, dots, dashes or underscores'),
        wait: z
          .boolean()
          .optional()
          .describe('Wait until the project is ready (default true, up to ~3 minutes)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, wait = true }) => {
      const created = createProject(user, name);
      const p = wait ? await waitUntilSettled(created.ref, 180_000) : created;
      if (p.status === 'ready')
        return json({
          project: projectView(p, { withSecrets: true }),
          next: 'Call get_agent_prompt with this ref for complete, step-by-step integration instructions with every key filled in.',
        });
      if (p.status === 'failed')
        return { ...json({ project: projectView(p, { withSecrets: false }) }), isError: true };
      return json({
        project: projectView(p, { withSecrets: false }),
        note: 'Still setting up. Call get_project with this ref in a minute.',
      });
    }
  );

  reg(
    'get_project',
    {
      title: 'Get project',
      description:
        'Status, API URL, anon key, API key, dashboard login and Postgres connection string of a project.',
      inputSchema: { ref },
      annotations: readOnly,
    },
    async ({ ref: r }) => {
      const p = ownedProject(user, r);
      return json({ project: projectView(p, { withSecrets: p.status === 'ready' }) });
    }
  );

  reg(
    'get_agent_prompt',
    {
      title: 'Get AI integration prompt',
      description:
        'Complete integration instructions for a project with every key filled in: env values, SDK setup, schema + row-level security, auth, database, storage, edge functions, realtime and security rules. Follow it to wire Mojobase into the current codebase.',
      inputSchema: { ref },
      annotations: readOnly,
    },
    async ({ ref: r }) => {
      const p = ownedProject(user, r);
      if (p.status !== 'ready')
        throw new ServiceError(409, `Project is ${p.status}, not ready yet.`);
      return { content: [{ type: 'text', text: agentPrompt(p) }] };
    }
  );

  reg(
    'get_integration_guide',
    {
      title: 'Get integration guide',
      description:
        'Ready-to-paste .env values and code to connect an app to a project (JavaScript/TypeScript SDK, Prisma, Drizzle, psql, REST).',
      inputSchema: {
        ref,
        stack: z
          .enum(['all', 'sdk', 'prisma', 'drizzle', 'psql', 'rest'])
          .optional()
          .describe('Which snippets (default all)'),
      },
      annotations: readOnly,
    },
    async ({ ref: r, stack }) => {
      const p = ownedProject(user, r);
      if (p.status !== 'ready')
        throw new ServiceError(409, `Project is ${p.status}, not ready yet.`);
      return json(integrationGuide(p, stack));
    }
  );

  reg(
    'delete_project',
    {
      title: 'Delete project',
      description:
        'Permanently delete a project: its database, users, files, functions and backups. Cannot be undone. Requires the exact project name as confirmation.',
      inputSchema: { ref, confirm_name: z.string().describe('The exact project name, to confirm') },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ref: r, confirm_name }) => {
      const p = ownedProject(user, r);
      if (confirm_name !== p.name)
        throw new ServiceError(
          400,
          `confirm_name must be exactly "${p.name}" to delete this project.`
        );
      await deleteProject(user, p.ref);
      return text(`Project ${p.name} (${p.ref}) deleted.`);
    }
  );

  reg(
    'backup_project',
    {
      title: 'Back up project',
      description: 'Take a database backup now (pg_dump). Nightly backups also run automatically.',
      inputSchema: { ref },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ref: r }) => {
      const p = ownedProject(user, r);
      if (p.status !== 'ready')
        throw new ServiceError(409, `Project is ${p.status}, not ready yet.`);
      const file = await backupProject(p.ref);
      return json({ created: file, backups: listBackups(p.ref) });
    }
  );

  reg(
    'list_backups',
    {
      title: 'List backups',
      description: 'List database backups of a project (newest first).',
      inputSchema: { ref },
      annotations: readOnly,
    },
    async ({ ref: r }) => json({ backups: listBackups(ownedProject(user, r).ref) })
  );

  // ------------------------------------------------------------ inside a project
  reg(
    'run_sql',
    {
      title: 'Run SQL',
      description:
        'Run SQL in a project database as the project admin (DDL and DML: create tables, RLS policies, grants, queries). Returns rows for queries. Use parameters ($1, $2...) for values.',
      inputSchema: {
        ref,
        query: z
          .string()
          .describe('SQL to run. Multiple statements are allowed when no params are used.'),
        params: z.array(z.unknown()).optional().describe('Values for $1, $2, ... placeholders'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ref: r, query, params }) => {
      const p = ownedProject(user, r);
      const res = await projectApi(p, 'POST', '/api/database/advance/rawsql', {
        query,
        ...(params ? { params } : {}),
      });
      return json({ rowCount: res?.rowCount ?? null, rows: res?.rows ?? res });
    }
  );

  reg(
    'list_tables',
    {
      title: 'List tables',
      description: 'List tables in the public schema of a project.',
      inputSchema: { ref },
      annotations: readOnly,
    },
    async ({ ref: r }) =>
      json(await projectApi(ownedProject(user, r), 'GET', '/api/database/tables'))
  );

  reg(
    'get_table_schema',
    {
      title: 'Get table schema',
      description: 'Columns, types, keys and constraints of a table.',
      inputSchema: { ref, table: z.string().describe('Table name') },
      annotations: readOnly,
    },
    async ({ ref: r, table }) =>
      json(
        await projectApi(
          ownedProject(user, r),
          'GET',
          `/api/database/tables/${encodeURIComponent(table)}/schema`
        )
      )
  );

  reg(
    'list_buckets',
    {
      title: 'List storage buckets',
      description: 'List file storage buckets of a project.',
      inputSchema: { ref },
      annotations: readOnly,
    },
    async ({ ref: r }) =>
      json(await projectApi(ownedProject(user, r), 'GET', '/api/storage/buckets'))
  );

  reg(
    'create_bucket',
    {
      title: 'Create storage bucket',
      description:
        'Create a file storage bucket. Public buckets serve files to anyone with the URL.',
      inputSchema: {
        ref,
        name: z.string().describe('Bucket name, e.g. "avatars"'),
        public: z.boolean().optional().describe('Public bucket (default false)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ref: r, name, public: isPublic = false }) =>
      json(
        await projectApi(ownedProject(user, r), 'POST', '/api/storage/buckets', {
          bucketName: name,
          isPublic,
        })
      )
  );

  reg(
    'list_functions',
    {
      title: 'List edge functions',
      description: 'List edge functions deployed in a project.',
      inputSchema: { ref },
      annotations: readOnly,
    },
    async ({ ref: r }) => json(await projectApi(ownedProject(user, r), 'GET', '/api/functions'))
  );

  reg(
    'deploy_function',
    {
      title: 'Deploy edge function',
      description:
        'Create or update an edge function (Deno). The code must assign the handler: module.exports = async function (request) { return new Response(...) }. It is then served at <project URL>/functions/<slug>. Call get_docs with topic "functions-sdk" for details.',
      inputSchema: {
        ref,
        slug: z
          .string()
          .regex(/^[a-zA-Z0-9_-]+$/)
          .describe('URL name, e.g. "send-welcome-email"'),
        code: z.string().describe('JavaScript source'),
        name: z.string().optional().describe('Display name (defaults to the slug)'),
        description: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ref: r, slug, code, name, description }) => {
      const p = ownedProject(user, r);
      const existing = await projectApi(p, 'GET', '/api/functions');
      const list = existing?.functions ?? existing ?? [];
      const exists = Array.isArray(list) && list.some((f) => f.slug === slug);
      const body = {
        name: name || slug,
        code,
        ...(description ? { description } : {}),
        status: 'active',
      };
      const res = exists
        ? await projectApi(p, 'PUT', `/api/functions/${encodeURIComponent(slug)}`, body)
        : await projectApi(p, 'POST', '/api/functions', { ...body, slug });
      return json({
        deployed: slug,
        url: `${projectView(p, { withSecrets: false }).apiUrl}/functions/${slug}`,
        result: res,
      });
    }
  );

  reg(
    'delete_function',
    {
      title: 'Delete edge function',
      description: 'Delete an edge function from a project.',
      inputSchema: { ref, slug: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ref: r, slug }) =>
      json(
        await projectApi(
          ownedProject(user, r),
          'DELETE',
          `/api/functions/${encodeURIComponent(slug)}`
        )
      )
  );

  reg(
    'list_users',
    {
      title: 'List auth users',
      description: "List the project's app users (sign-ups through Mojobase auth).",
      inputSchema: { ref, limit: z.number().int().min(1).max(100).optional() },
      annotations: readOnly,
    },
    async ({ ref: r, limit = 20 }) =>
      json(await projectApi(ownedProject(user, r), 'GET', `/api/auth/users?limit=${limit}`))
  );

  reg(
    'get_docs',
    {
      title: 'Get docs',
      description:
        'Developer documentation for building on a project. Start with "instructions". Topics: instructions, db-sdk, auth-sdk, storage-sdk, functions-sdk, real-time, ai-integration-sdk, payments, deployment.',
      inputSchema: {
        ref,
        topic: z
          .enum([
            'instructions',
            'db-sdk',
            'auth-sdk',
            'storage-sdk',
            'functions-sdk',
            'real-time',
            'ai-integration-sdk',
            'payments',
            'deployment',
          ])
          .describe('Documentation topic'),
      },
      annotations: readOnly,
    },
    async ({ ref: r, topic }) => {
      const doc = await projectApi(ownedProject(user, r), 'GET', `/api/docs/${topic}`);
      const content =
        typeof doc === 'string' ? doc : (doc?.content ?? JSON.stringify(doc, null, 2));
      return text(String(content));
    }
  );

  return server;
}

// ------------------------------------------------------------ HTTP endpoint
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

const hits = new Map(); // per-token rate limit: 120 requests / minute
setInterval(() => hits.clear(), 60_000).unref();

export async function handleMcp(req, res) {
  const user = accessTokens.authenticate(bearer(req));
  if (!user) {
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="mojobase"')
      .json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message:
            'Missing or invalid access token. Create one at https://mojobase.dev/account and send it as "Authorization: Bearer mbp_...".',
        },
        id: null,
      });
    return;
  }
  const n = (hits.get(user.tokenId) || 0) + 1;
  hits.set(user.tokenId, n);
  if (n > 120) {
    res.status(429).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Rate limit: 120 requests per minute' },
      id: null,
    });
    return;
  }
  if (req.method !== 'POST') {
    // Stateless server: no server-initiated streams or sessions.
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }
  const server = buildServer(user);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
