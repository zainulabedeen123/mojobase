// Runtime configuration, all from environment variables.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
import fs from 'node:fs';

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
};

export const config = {
  port: int('PORT', 3000),
  // Internal-only port that Caddy calls to decide whether to issue a TLS certificate.
  internalPort: int('INTERNAL_PORT', 3001),
  dataDir: process.env.DATA_DIR || '/data',

  // 32+ random bytes, hex. Signs session cookies and encrypts project secrets at rest.
  consoleSecret: required('CONSOLE_SECRET'),

  // Public naming
  baseDomain: process.env.BASE_DOMAIN || 'mojobase.dev', // projects live at <ref>.<baseDomain>
  consoleOrigin: process.env.CONSOLE_ORIGIN || 'https://mojobase.dev',
  // How project stacks reach the console's internal port (JWKS for dashboard sign-in).
  consoleInternalUrl: process.env.CONSOLE_INTERNAL_URL || 'http://console:3001',
  dbHost: process.env.DB_HOST || 'db.mojobase.dev',

  // Images each project stack runs (published by .github/workflows/mojobase-image.yml)
  appImage: required('PROJECT_APP_IMAGE'),
  postgresImage: required('PROJECT_POSTGRES_IMAGE'),
  denoImage: required('PROJECT_DENO_IMAGE'),
  postgrestImage: process.env.PROJECT_POSTGREST_IMAGE || 'postgrest/postgrest:v12.2.12',

  // Shared docker resources created by the platform stack
  edgeNetwork: process.env.EDGE_NETWORK || 'mojobase-edge',
  caddyDataVolume: process.env.CADDY_DATA_VOLUME || 'mojobase-caddy-data',
  // Where the console sees Caddy's data volume (read-only), to check the DB certificate exists
  caddyDataMount: process.env.CADDY_DATA_MOUNT || '/caddy-data',
  acmeDirName: process.env.ACME_DIR_NAME || 'acme-v02.api.letsencrypt.org-directory',

  // Public Postgres ports, one per project. Must match the VPS firewall rule.
  dbPortMin: int('DB_PORT_MIN', 15400),
  dbPortMax: int('DB_PORT_MAX', 15499),

  // Capacity limits (public sign-up)
  maxProjects: int('MAX_PROJECTS', 8),
  maxProjectsPerUser: int('MAX_PROJECTS_PER_USER', 2),
  allowSignup: (process.env.ALLOW_SIGNUP ?? 'true') !== 'false',
  // Sign-in / sign-up / reset attempts per IP per minute.
  authRateLimit: int('AUTH_RATE_LIMIT', 10),

  // Email (Resend). The console sends account emails through the HTTP API; projects
  // get the same provider as their SMTP server for their own auth emails.
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'Mojobase <no-reply@mojobase.dev>',
  // New accounts must confirm their email before creating projects (default: on
  // whenever an email provider is configured).
  requireVerifiedEmail:
    (process.env.REQUIRE_VERIFIED_EMAIL ?? (process.env.RESEND_API_KEY ? 'true' : 'false')) ===
    'true',
  projectSmtp: {
    host: process.env.PROJECT_SMTP_HOST || 'smtp.resend.com',
    port: int('PROJECT_SMTP_PORT', 465),
    username: process.env.PROJECT_SMTP_USER || 'resend',
    password: process.env.PROJECT_SMTP_PASSWORD || process.env.RESEND_API_KEY || '',
    senderEmail: process.env.PROJECT_SMTP_SENDER || 'no-reply@mojobase.dev',
  },

  // Compose files for project stacks live here. On the server this is the host's
  // /docker directory (bind-mounted at the same path), which is where hPanel's
  // Docker Manager looks for projects, so console-created stacks show up there too.
  composeRoot: process.env.COMPOSE_ROOT || '/docker',

  // Nightly database backups: hour (UTC) and how many to keep per project.
  backupHourUtc: int('BACKUP_HOUR_UTC', 3),
  backupKeep: int('BACKUP_KEEP', 7),

  // Offsite backups (per-project destinations: Google Drive, S3-compatible storage).
  // Google Drive needs an OAuth client (Web application) whose authorized redirect URI
  // is <CONSOLE_ORIGIN>/api/backups/gdrive/callback. Without it, Drive is shown as
  // "not configured on this server".
  googleDrive: {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET || '',
    // Overridable for tests only.
    authUrl: process.env.GOOGLE_OAUTH_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    apiUrl: process.env.GOOGLE_DRIVE_API_URL || 'https://www.googleapis.com',
  },
  // S3 endpoints must be public https hosts unless this is set (e.g. a MinIO on the
  // same server or private network); then http and private addresses are allowed too.
  allowPrivateS3Endpoints: process.env.ALLOW_PRIVATE_S3_ENDPOINTS === '1',
  // Recorded in each offsite backup's manifest.
  mojobaseVersion: process.env.MOJOBASE_VERSION || packageVersion(),

  // Per-project memory limits
  mem: {
    postgres: process.env.PROJECT_MEM_POSTGRES || '512m',
    app: process.env.PROJECT_MEM_APP || '768m',
    deno: process.env.PROJECT_MEM_DENO || '256m',
    postgrest: process.env.PROJECT_MEM_POSTGREST || '128m',
  },
};

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

export const certDir = () =>
  `${config.caddyDataMount}/caddy/certificates/${config.acmeDirName}/${config.dbHost}`;
