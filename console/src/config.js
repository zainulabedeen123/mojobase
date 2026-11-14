// Runtime configuration, all from environment variables.
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};
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

  // Per-project memory limits
  mem: {
    postgres: process.env.PROJECT_MEM_POSTGRES || '512m',
    app: process.env.PROJECT_MEM_APP || '768m',
    deno: process.env.PROJECT_MEM_DENO || '256m',
    postgrest: process.env.PROJECT_MEM_POSTGREST || '128m',
  },
};

export const certDir = () =>
  `${config.caddyDataMount}/caddy/certificates/${config.acmeDirName}/${config.dbHost}`;
