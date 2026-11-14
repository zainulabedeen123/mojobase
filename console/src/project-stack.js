// Builds the docker compose definition for one project's isolated backend stack.
// Written as JSON (valid YAML), so no YAML escaping is involved; `$` is doubled
// because compose interpolates it.
import crypto from 'node:crypto';
import { config } from './config.js';

const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// Postgres/URL-safe password (no characters that need escaping in a connection URI)
const password = (len = 32) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(len);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
};

export const DB_USER = 'mojobase';
export const DB_NAME = 'insforge';

export function newRef() {
  // 16 chars, starts with a letter: valid as a DNS label and a docker project name.
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const alnum = letters + '0123456789';
  const b = crypto.randomBytes(16);
  return letters[b[0] % 26] + Array.from(b.subarray(1), (x) => alnum[x % alnum.length]).join('');
}

export function newSecrets() {
  return {
    jwtSecret: hex(32),
    encryptionKey: hex(32),
    postgresPassword: password(40), // superuser, never leaves the server
    dbPassword: password(32), // the user-facing connection-string role
    adminPassword: password(20), // project dashboard login (username "admin")
    apiKey: `ik_${hex(32)}`,
    anonKey: `anon_${hex(32)}`,
  };
}

export const projectHost = (ref) => `${ref}.${config.baseDomain}`;
export const appContainer = (ref) => `mb-${ref}-app`;
export const postgresContainer = (ref) => `mb-${ref}-postgres`;
export const composeProject = (ref) => `mb-${ref}`;

export function connectionString(ref, port, secrets) {
  return `postgresql://${DB_USER}:${secrets.dbPassword}@${config.dbHost}:${port}/${DB_NAME}?sslmode=require`;
}

// Postgres starts with TLS using the Let's Encrypt certificate Caddy holds for
// db.<domain>. Connections from the internet must use TLS; connections from the
// project's own containers (private docker networks) may skip it.
function postgresBoot(secrets) {
  const cert = `/caddy-data/caddy/certificates/${config.acmeDirName}/${config.dbHost}/${config.dbHost}`;
  const hba = [
    'local all all trust',
    'host all all 127.0.0.1/32 scram-sha-256',
    'host all all 172.16.0.0/12 scram-sha-256',
    'host all all 192.168.0.0/16 scram-sha-256',
    'host all all 10.0.0.0/8 scram-sha-256',
    'hostssl all all 0.0.0.0/0 scram-sha-256',
    'hostnossl all all 0.0.0.0/0 reject',
  ].join('\\n');
  return [
    'set -e',
    'mkdir -p /etc/mojobase',
    `cp ${cert}.crt /etc/mojobase/server.crt`,
    `cp ${cert}.key /etc/mojobase/server.key`,
    `printf '${hba}\\n' > /etc/mojobase/pg_hba.conf`,
    'chown -R postgres:postgres /etc/mojobase',
    'chmod 600 /etc/mojobase/server.key',
    'exec docker-entrypoint.sh postgres' +
      ' -c config_file=/etc/postgresql/postgresql.conf' +
      ' -c hba_file=/etc/mojobase/pg_hba.conf' +
      ' -c ssl=on -c ssl_cert_file=/etc/mojobase/server.crt -c ssl_key_file=/etc/mojobase/server.key' +
      ' -c ssl_min_protocol_version=TLSv1.2' +
      ` -c cron.database_name=${DB_NAME}` +
      ` -c app.encryption_key=${secrets.encryptionKey}`,
  ].join('\n');
}

export function composeFile(ref, port, secrets) {
  const pg = {
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: secrets.postgresPassword,
    POSTGRES_DB: DB_NAME,
  };
  const pgUrl = `postgres://postgres:${secrets.postgresPassword}@postgres:5432/${DB_NAME}`;
  const hardening = { security_opt: ['no-new-privileges:true'], restart: 'unless-stopped' };
  const doc = {
    name: composeProject(ref),
    services: {
      postgres: {
        ...hardening,
        image: config.postgresImage,
        container_name: postgresContainer(ref),
        entrypoint: ['/bin/sh', '-c'],
        command: [postgresBoot(secrets).replaceAll('$', '$$')],
        environment: {
          ...pg,
          ENCRYPTION_KEY: secrets.encryptionKey,
          PGDATA: '/var/lib/postgresql/data/pgdata',
        },
        volumes: ['pgdata:/var/lib/postgresql/data', 'caddy-data:/caddy-data:ro'],
        // IPv4 only: IPv6 publishing goes through docker-proxy, which would hide the client IP.
        ports: [`0.0.0.0:${port}:5432`],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U postgres'],
          interval: '5s',
          timeout: '5s',
          retries: 10,
        },
        mem_limit: config.mem.postgres,
        networks: ['internal'],
      },
      postgrest: {
        ...hardening,
        image: config.postgrestImage,
        environment: {
          PGRST_DB_URI: pgUrl,
          PGRST_OPENAPI_SERVER_PROXY_URI: 'http://localhost:3000',
          PGRST_DB_SCHEMA: 'public',
          PGRST_DB_ANON_ROLE: 'anon',
          PGRST_JWT_SECRET: secrets.jwtSecret,
          PGRST_DB_POOL: '20',
          PGRST_DB_CHANNEL_ENABLED: 'true',
          PGRST_DB_CHANNEL: 'pgrst',
        },
        depends_on: { postgres: { condition: 'service_healthy' } },
        mem_limit: config.mem.postgrest,
        networks: ['internal'],
      },
      app: {
        ...hardening,
        image: config.appImage,
        container_name: appContainer(ref),
        working_dir: '/app',
        depends_on: {
          postgres: { condition: 'service_healthy' },
          postgrest: { condition: 'service_started' },
        },
        environment: {
          PORT: '7130',
          PROJECT_ROOT: '/app',
          API_BASE_URL: `https://${projectHost(ref)}`,
          VITE_API_BASE_URL: `https://${projectHost(ref)}`,
          JWT_SECRET: secrets.jwtSecret,
          ENCRYPTION_KEY: secrets.encryptionKey,
          ROOT_ADMIN_USERNAME: 'admin',
          ROOT_ADMIN_PASSWORD: secrets.adminPassword,
          ADMIN_EMAIL: 'admin',
          ADMIN_PASSWORD: secrets.adminPassword,
          ACCESS_API_KEY: secrets.apiKey,
          ACCESS_ANON_KEY: secrets.anonKey,
          POSTGRES_HOST: 'postgres',
          POSTGRES_PORT: '5432',
          POSTGRES_DB: DB_NAME,
          POSTGRES_USER: 'postgres',
          POSTGRES_PASSWORD: secrets.postgresPassword,
          DATABASE_URL: pgUrl.replace('postgres://', 'postgresql://'),
          POSTGREST_BASE_URL: 'http://postgrest:3000',
          DENO_RUNTIME_URL: 'http://deno:7133',
          LOGS_DIR: '/insforge-logs',
          STORAGE_DIR: '/insforge-storage',
          COMPUTE_DEFAULT_INGRESS: 'none',
          COMPUTE_BIND_ADDRESS: '127.0.0.1',
          INSFORGE_TELEMETRY_DISABLED: '1',
          // The console acts as this project's "cloud": its dashboard, embedded at
          // mojobase.dev, signs in with tokens the console signs (verified against
          // the console's JWKS). Outbound cloud features stay off (no AWS env).
          PROJECT_ID: ref,
          CLOUD_API_HOST: config.consoleInternalUrl,
          INSFORGE_DEPLOYMENT_METHOD: 'mojobase-console',
        },
        volumes: ['storage:/insforge-storage', 'logs:/insforge-logs'],
        mem_limit: config.mem.app,
        // Edge functions reach their project's API at http://insforge:7130 (the
        // INSFORGE_INTERNAL_URL secret every project seeds), so keep that name.
        networks: { internal: { aliases: ['insforge'] }, edge: {} },
      },
      deno: {
        ...hardening,
        image: config.denoImage,
        working_dir: '/app',
        command: [
          'sh',
          '-c',
          'deno cache --no-lock functions/server.ts && deno run --no-lock --unstable-worker-options --allow-net --allow-env --allow-read=./functions/worker-template.js functions/server.ts',
        ],
        depends_on: ['postgres', 'postgrest'],
        environment: {
          PORT: '7133',
          DENO_ENV: 'production',
          DENO_DIR: '/deno-dir',
          ...Object.fromEntries(
            Object.entries({
              POSTGRES_HOST: 'postgres',
              POSTGRES_PORT: '5432',
              POSTGRES_DB: DB_NAME,
              POSTGRES_USER: 'postgres',
              POSTGRES_PASSWORD: secrets.postgresPassword,
            })
          ),
          POSTGREST_BASE_URL: 'http://postgrest:3000',
          WORKER_TIMEOUT_MS: '60000',
          ENCRYPTION_KEY: secrets.encryptionKey,
          JWT_SECRET: secrets.jwtSecret,
        },
        volumes: ['deno_cache:/deno-dir'],
        mem_limit: config.mem.deno,
        networks: ['internal'],
      },
    },
    networks: {
      internal: {},
      edge: { external: true, name: config.edgeNetwork },
    },
    volumes: {
      pgdata: {},
      storage: {},
      logs: {},
      deno_cache: {},
      'caddy-data': { external: true, name: config.caddyDataVolume },
    },
  };
  return JSON.stringify(doc, null, 2);
}

// SQL run once the app has finished its migrations: the login role behind the
// connection string. It acts as project_admin (owner of user objects in public,
// no superuser), the same role the dashboard's SQL editor uses.
export function connectionRoleSql(secrets) {
  return `
DO $mb$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${secrets.dbPassword}' IN ROLE project_admin;
  ELSE
    ALTER ROLE ${DB_USER} LOGIN PASSWORD '${secrets.dbPassword}';
  END IF;
END
$mb$;
ALTER ROLE ${DB_USER} SET role = 'project_admin';
ALTER ROLE ${DB_USER} CONNECTION LIMIT 40;
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${DB_USER};
`;
}
