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
# On the server: secrets go in /opt/mojobase/platform.env (chmod 600), never in the compose file
#   CONSOLE_SECRET=<openssl rand -hex 32>   keep it: it encrypts project secrets
#   RESEND_API_KEY=re_...                   optional: enables all email (see below)
#   GOOGLE_DRIVE_CLIENT_ID=...              optional: offsite backups to Google Drive (see Backups)
#   GOOGLE_DRIVE_CLIENT_SECRET=...
docker compose -f deploy/platform/docker-compose.yml up -d
```

`docker-compose.yml` is generated: edit `Caddyfile` or `render-compose.py`, then run
`python3 deploy/platform/render-compose.py > deploy/platform/docker-compose.yml`.

## Email

With `RESEND_API_KEY` set (and the sending domain verified in Resend):

- the console sends email verification and password-reset links from `no-reply@<domain>`,
  and new accounts must confirm their email before creating projects;
- every new project is configured to send its own auth emails (verification, password
  reset, magic links) through Resend SMTP; owners can change it in the project dashboard.

## Backups

### Local backups

Every ready project's database is dumped nightly (`BACKUP_HOUR_UTC`, default 03:00) with
`pg_dump -Fc` into the console's data volume; the newest `BACKUP_KEEP` (default 7) are kept.
Owners can also back up on demand and download dumps from the project page. Restore with
`pg_restore`. These stay on the server, so they don't survive losing it.

### Offsite backups

Owners send copies off the server from the project page (**Offsite backups**, next to
Connect). Each project has its own:

- **Destinations** (up to 5): Google Drive, and S3-compatible storage (AWS S3, Cloudflare R2,
  Backblaze B2, Wasabi, MinIO, …: endpoint, region, bucket, optional prefix, access key,
  path-style toggle). **Test** writes and deletes a small object.
- **Schedule**: UTC hours, default 03:00 and 15:00 (twice a day), checked on the console's
  5-minute backup timer; each hour slot runs once, even across restarts.
- **Retention**: default 30 days; **include files**: default on.

Each run (scheduled or **Back up now**) takes a `pg_dump -Fc` of the database, a `tar.gz`
of the project's storage volume (`/insforge-storage` in `mb-<ref>-app`) and a
`manifest.json` (project, time, sizes, sha256 of each file, Mojobase version), staged in
`/data/offsite-staging` and removed afterwards. They are uploaded to every enabled
destination at

```
<prefix>/mojobase/<project-name>-<ref>/<YYYY-MM-DD>T<HHMM>Z/{database.dump,storage.tar.gz,manifest.json}
```

(Google Drive: `My Drive/<folder>/<project-name>-<ref>/<YYYY-MM-DD>T<HHMM>Z/`), then that
destination's runs older than the retention are deleted. Destinations are independent: one
failing never stops the others. Large files go up in parts (S3 multipart above 50 MB, Drive
resumable uploads), streamed from disk. The last runs and each destination's result
(size, duration, error) show on the project page. When a scheduled run fails for any
destination and email is configured, the owner gets one email per project per day at most.

Keys and refresh tokens are stored encrypted with `CONSOLE_SECRET` and never sent back to the
browser. S3 endpoints must be public `https://` hosts; private, loopback and link-local
addresses are refused (also when a host name resolves to one). To use a MinIO on the same
server or a private network, set `ALLOW_PRIVATE_S3_ENDPOINTS=1` (this also allows `http://`).

#### Google Drive setup

1. In Google Cloud Console, enable the **Google Drive API** and configure the OAuth consent
   screen (scope `https://www.googleapis.com/auth/drive.file` only: Mojobase can see just the
   files it creates, never the rest of the Drive). While the app is in "Testing", only listed
   test users can connect and Google expires their refresh tokens after 7 days, so publish it
   for real use.
2. Create an **OAuth client ID** of type *Web application* with the authorized redirect URI
   `https://<console domain>/api/backups/gdrive/callback` (here
   `https://mojobase.dev/api/backups/gdrive/callback`, i.e. `CONSOLE_ORIGIN` +
   `/api/backups/gdrive/callback`).
3. Put `GOOGLE_DRIVE_CLIENT_ID` and `GOOGLE_DRIVE_CLIENT_SECRET` in `/opt/mojobase/platform.env`
   and restart the console. Without them the project page shows Google Drive as "not
   configured on this server"; S3 destinations work regardless.

#### Restoring from an offsite copy

Download one run folder (`database.dump`, `storage.tar.gz`, `manifest.json`) and check the
files against the sha256 values in the manifest (`sha256sum database.dump storage.tar.gz`).

Database, easiest: copy the dump into the console as a local backup of the target project,
then use **Restore** in that project's dashboard (a safety backup is taken first):

```bash
docker cp database.dump <console container>:/data/backups/<ref>/<ref>-20260101T030000Z.dump
```

(the file name must be `<ref>-<YYYYMMDD>T<HHMMSS>Z.dump`). Or restore by hand:

```bash
docker cp database.dump mb-<ref>-postgres:/tmp/database.dump
docker compose -p mb-<ref> -f /docker/mb-<ref>/docker-compose.yml stop app postgrest deno
docker exec mb-<ref>-postgres psql -U postgres -d postgres -c 'DROP DATABASE insforge WITH (FORCE);'
docker exec mb-<ref>-postgres pg_restore -U postgres -d postgres --create --exit-on-error /tmp/database.dump
docker compose -p mb-<ref> -f /docker/mb-<ref>/docker-compose.yml restart postgres
docker compose -p mb-<ref> -f /docker/mb-<ref>/docker-compose.yml up -d
```

Any other Postgres works too: `pg_restore --no-owner -d "$DATABASE_URL" database.dump`.

Files: unpack the archive into the project's storage volume, then restart the app:

```bash
docker run --rm -v mb-<ref>_storage:/s -v "$PWD":/b alpine tar xzf /b/storage.tar.gz -C /s
docker restart mb-<ref>-app
```

## hPanel / Docker Manager

Project compose files are written to the host's `/docker/mb-<ref>/docker-compose.yml`, so
they appear in hPanel's Docker Manager. Manage projects from the console; stopping or
deleting one in hPanel bypasses the console's records.

## How a project works

Creating a project starts four containers (Postgres, PostgREST, the Mojobase API and
dashboard, Deno functions) with generated secrets and memory limits. Postgres:

- uses the Let's Encrypt certificate Caddy holds for `db.mojobase.dev` (refreshed every 12h);
- accepts internet connections only over TLS (`pg_hba` rejects unencrypted ones);
- gives the connection string a `mojobase` login role that acts as `project_admin`
  (owner of the project's tables, not a superuser).

Limits are set on the console: `MAX_PROJECTS` (default 8) and `MAX_PROJECTS_PER_USER` (default 2).
Each project uses roughly 400-600 MB of RAM.
