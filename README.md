<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/mojobase-logo-dark.svg">
    <img src="assets/brand/mojobase-logo-light.svg" alt="Mojobase" height="64">
  </picture>
</p>

<p align="center"><b>Open-source backend platform for all your projects.</b><br>
Postgres database, auth, storage, edge functions, realtime and AI — self-hosted, agent-ready.</p>

---

Mojobase is a self-hosted backend-as-a-service, an alternative to Supabase and Neon that you run on
your own server. It is built on [InsForge](https://github.com/InsForge/InsForge) and stays
compatible with the InsForge SDK, CLI and MCP server, so coding agents and existing InsForge
tooling work against a Mojobase instance unchanged.

## What you get

- **Database** — PostgreSQL 15 with an auto-generated REST API (PostgREST), RLS and migrations
- **Auth** — email/password and OAuth (Google, GitHub, Discord, Microsoft, Apple, …)
- **Storage** — local disk or any S3-compatible store
- **Edge functions** — Deno runtime
- **Realtime, AI gateway, payments, scheduled jobs** and an admin dashboard

## Self-host with Docker

```bash
git clone <this-repo> mojobase && cd mojobase
cp .env.example .env   # then set JWT_SECRET, ENCRYPTION_KEY, POSTGRES_PASSWORD, ROOT_ADMIN_PASSWORD
docker compose -f deploy/docker-compose/docker-compose.yml --env-file .env up -d
```

Open `http://localhost:7130` and sign in with the admin credentials from `.env`.

## Run it as a platform (many projects)

`deploy/platform/` runs the Mojobase console at your domain: people sign up, create
projects, and each project gets its own isolated backend at `<ref>.your-domain`, API keys,
a project dashboard and a Postgres connection string (`db.your-domain:<port>`, TLS required).
See [deploy/platform/README.md](deploy/platform/README.md).

## Using it from your apps

Mojobase speaks the InsForge API, so use the InsForge client libraries and point them at your
Mojobase URL:

```bash
npm install @insforge/sdk
```

```ts
import { createClient } from '@insforge/sdk';
const mojobase = createClient({ baseUrl: 'https://api.your-domain.dev', anonKey: '<anon key>' });
```

Detailed API and feature docs: see [`docs/`](docs/) and the upstream documentation at
<https://docs.insforge.dev>.

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
