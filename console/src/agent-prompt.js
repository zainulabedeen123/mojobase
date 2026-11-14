// A ready-to-paste prompt that gives a coding agent (Claude Code, Cursor, Codex,
// Windsurf, Copilot…) everything it needs to wire a Mojobase project into an app:
// the real URL, keys and connection string, plus verified SDK/REST usage.
// Shared by the console UI, the REST API and the MCP server.
import { config } from './config.js';
import { projectView } from './projects-service.js';

export function agentPrompt(p) {
  const v = projectView(p, { withSecrets: true });
  const db = v.database;
  const mcpUrl = `${config.consoleOrigin}/mcp`;
  return `# Integrate the Mojobase backend "${v.name}" into this app

You are connecting this codebase to a Mojobase project: a hosted backend with Postgres,
authentication, file storage, edge functions and realtime. Its client library is \`@mojobase/sdk\`. Full docs: ${config.consoleOrigin}/docs. Everything below is real and ready to use: do not ask me for keys.

## 1. Credentials

| What | Value | Where it may be used |
|---|---|---|
| Project URL | ${v.apiUrl} | anywhere |
| Anon key | ${v.anonKey} | browser, mobile and server code |
| API key (admin) | ${v.apiKey} | server-side/admin scripts ONLY |
| Postgres URL | ${db.connectionString} | server-side/migrations ONLY |

Put them in the project's env file (\`.env.local\` / \`.env\`) and make sure that file is in
\`.gitignore\`. Use the public prefix the framework needs for the browser-safe values
(\`NEXT_PUBLIC_\` for Next.js, \`VITE_\` for Vite, \`EXPO_PUBLIC_\` for Expo, none for Node):

\`\`\`bash
MOJOBASE_URL=${v.apiUrl}
MOJOBASE_ANON_KEY=${v.anonKey}
# Server-only secrets: never import these in client components or ship them to the browser
MOJOBASE_API_KEY=${v.apiKey}
DATABASE_URL=${db.connectionString}
\`\`\`

Direct Postgres details: host ${db.host}, port ${db.port}, database ${db.database},
user ${db.user}, password ${db.password}. TLS is required (sslmode=require). The role owns
everything in the \`public\` schema but is not a superuser.

## 2. Install and create one shared client

\`\`\`bash
npm install @mojobase/sdk
\`\`\`

\`\`\`ts
// lib/mojobase.ts
import { createClient } from '@mojobase/sdk';

export const mojobase = createClient({
  baseUrl: process.env.MOJOBASE_URL!,     // use the framework's public env name in browser code
  anonKey: process.env.MOJOBASE_ANON_KEY!,
});
\`\`\`

Every SDK call returns \`{ data, error }\`. Always check \`error\`.

## 3. Create the database schema

Design the tables this app needs, then create them with SQL. Pick ONE way:

- **Migrations (preferred if the app uses Prisma/Drizzle/Knex):** point the tool at \`DATABASE_URL\`.
- **SQL over HTTP (no extra tooling):**
  \`\`\`bash
  curl -X POST '${v.apiUrl}/api/database/advance/rawsql' \\
    -H 'Authorization: Bearer ${v.apiKey}' -H 'Content-Type: application/json' \\
    -d '{"query": "SELECT now()"}'
  \`\`\`
- **psql:** \`psql "${db.connectionString}"\`

Rules for every table the app reads or writes from the client:
- New tables in \`public\` are automatically reachable by the \`anon\` and \`authenticated\` roles,
  so ALWAYS enable row-level security and add policies. \`auth.uid()\` is the signed-in user's id.
- Reference users with \`user_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE\`.

Example (adapt to the app's real data model):

\`\`\`sql
CREATE TABLE public.todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows: read"   ON public.todos FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own rows: insert" ON public.todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "own rows: update" ON public.todos FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "own rows: delete" ON public.todos FOR DELETE TO authenticated USING (user_id = auth.uid());
\`\`\`

## 4. Authentication

\`\`\`ts
const { data, error } = await mojobase.auth.signUp({ email, password, name, redirectTo: \`\${origin}/sign-in\` });
if (data?.requireEmailVerification) {
  // Email verification is on: the user gets an email (a link, or a 6-digit code). For codes:
  await mojobase.auth.verifyEmail({ email, otp: code });
}
await mojobase.auth.signInWithPassword({ email, password });
const { data: { user } } = await mojobase.auth.getCurrentUser(); // call on app start to restore the session
await mojobase.auth.signOut();
\`\`\`

Also available: \`signInWithOAuth\` (Google, GitHub… once enabled in the dashboard),
\`sendResetPasswordEmail\`, \`getProfile\` / \`setProfile\`.

## 5. Database queries (row-level security applies to the signed-in user)

\`\`\`ts
const { data: todos } = await mojobase.database.from('todos').select('*').order('created_at', { ascending: false });
await mojobase.database.from('todos').insert([{ title: 'Ship it' }]).select();
await mojobase.database.from('todos').update({ done: true }).eq('id', id);
await mojobase.database.from('todos').delete().eq('id', id);
\`\`\`

## 6. File storage

Create each bucket once (admin call):

\`\`\`bash
curl -X POST '${v.apiUrl}/api/storage/buckets' \\
  -H 'Authorization: Bearer ${v.apiKey}' -H 'Content-Type: application/json' \\
  -d '{"bucketName": "avatars", "isPublic": true}'
\`\`\`

\`\`\`ts
const { data } = await mojobase.storage.from('avatars').upload(\`\${user.id}/avatar.png\`, file);
// Save BOTH data.url (to display) and data.key (to download/remove) in your table.
const { data: blob } = await mojobase.storage.from('avatars').download(key);
await mojobase.storage.from('avatars').remove(key);
\`\`\`

## 7. Edge functions (server-side code, Deno runtime)

Deploy or update a function (slug = URL name; \`code\` is the JS source as a string):

\`\`\`bash
curl -X POST '${v.apiUrl}/api/functions' \\
  -H 'Authorization: Bearer ${v.apiKey}' -H 'Content-Type: application/json' \\
  -d '{"slug": "hello", "name": "hello", "status": "active", "code": "module.exports = async function (req) { const body = await req.json().catch(() => ({})); return new Response(JSON.stringify({ hello: body.name || \\"world\\" }), { headers: { \\"Content-Type\\": \\"application/json\\" } }); }"}'
# To redeploy an existing function: PUT ${v.apiUrl}/api/functions/hello with the same body (without slug)
\`\`\`

A function exports \`module.exports = async function (request) { ...; return new Response(...) }\`.
Inside it, \`createClient\` is available globally and \`Deno.env.get('INSFORGE_INTERNAL_URL')\`
is this project's internal API URL. Call it from the app:

\`\`\`ts
const { data, error } = await mojobase.functions.invoke('hello', { body: { name: 'Ada' } });
\`\`\`

It is also served over plain HTTP at ${v.apiUrl}/functions/hello (send JSON bodies with
\`Content-Type: application/json\`; the SDK does this for you).

## 8. Realtime (optional)

Register each channel (or pattern such as \`order:%\`) once with SQL, then subscribe and publish:

\`\`\`sql
INSERT INTO realtime.channels (pattern, description, enabled) VALUES ('todos', 'Todo updates', true);
-- From a trigger: PERFORM realtime.publish('todos', 'todo_created', to_jsonb(NEW));
\`\`\`

\`\`\`ts
await mojobase.realtime.connect();
await mojobase.realtime.subscribe('todos');
mojobase.realtime.on('todo_created', (msg) => { /* update UI */ });
await mojobase.realtime.publish('todos', 'todo_created', { id });
\`\`\`

## Rules

1. Only the anon key and project URL may appear in client/browser/mobile code.
2. The API key and \`DATABASE_URL\` give full admin access: server code, scripts and migrations only.
3. Every table the client touches has RLS enabled and explicit policies.
4. Never commit the env file. Add \`.env*\` to \`.gitignore\` if it is not already there.
5. Keep all access going through \`lib/mojobase.ts\` (or the server-side equivalent).

## Done when

- The app signs a user up and in, and keeps the session across reloads.
- The app's own tables exist with RLS, and the user can create and read their own rows.
- \`npm run build\` (or the project's build/typecheck) passes.
- Quick API check: \`curl '${v.apiUrl}/api/health'\` returns OK.

Dashboard (tables, users, logs, SQL editor): ${config.consoleOrigin}/projects/${v.ref}
Optional: if your agent supports MCP, connect ${mcpUrl} with a token from
${config.consoleOrigin}/agents to manage this project (SQL, buckets, functions) directly.
`;
}
