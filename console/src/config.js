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
