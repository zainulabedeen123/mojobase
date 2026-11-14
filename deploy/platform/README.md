# Mojobase platform (multi-project)

This stack turns one server into a Mojobase platform where people sign up and
create projects, each with its own backend and Postgres connection string.

| Host | Served by |
|---|---|
| `mojobase.dev` | console: sign up, create/delete projects, keys and connection strings |
| `<ref>.mojobase.dev` | that project's API and dashboard (TLS certificate issued on demand) |
| `db.mojobase.dev:<port>` | that project's Postgres, TLS required |
| `api.mojobase.dev` | the original single instance (optional) |

## Requirements

- DNS: `A` records for `@`, `*` (and `api`, `db` if not covered by `*`) pointing at the server.
- Firewall: TCP 80, 443 and the database port range (default `15400-15499`).
- Docker with the compose plugin. The console uses the host Docker socket to create
  and remove project stacks (`mb-<ref>`).
- An external network named `mojobase-edge` (`docker network create mojobase-edge`, or
  let the single-instance stack create it).

## Deploy

```bash
export MOJOBASE_TAG=<image tag from the "Publish Mojobase images" workflow, e.g. a short sha>
export CONSOLE_SECRET=$(openssl rand -hex 32)   # keep it: it encrypts project secrets
docker compose -f deploy/platform/docker-compose.yml up -d
```

## How a project works

Creating a project starts four containers (Postgres, PostgREST, the Mojobase API and
dashboard, Deno functions) with generated secrets and memory limits. Postgres:

- uses the Let's Encrypt certificate Caddy holds for `db.mojobase.dev` (refreshed every 12h);
- accepts internet connections only over TLS (`pg_hba` rejects unencrypted ones);
- gives the connection string a `mojobase` login role that acts as `project_admin`
  (owner of the project's tables, not a superuser).

Limits are set on the console: `MAX_PROJECTS` (default 8) and `MAX_PROJECTS_PER_USER` (default 2).
Each project uses roughly 400-600 MB of RAM.
