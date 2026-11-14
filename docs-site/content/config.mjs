// What to keep, drop, add and patch when turning the upstream docs into the
// Mojobase docs. Patches run on the raw MDX *before* rebranding, so they match
// the upstream wording ("InsForge", "npx @insforge/cli ...").

// Pages that do not apply to Mojobase (hosted platform, no CLI).
export const EXCLUDED = {
  pricing: 'InsForge Cloud pricing',
  partnership: 'InsForge partner program',
  'referral-program': 'InsForge referral program',
  showcase: 'InsForge community showcase',
  alternatives: 'InsForge marketing comparison (CLI/Sites claims)',
  'oauth-server':
    '"Sign in with InsForge" platform OAuth (api.insforge.dev), not a project backend feature',
  'core-concepts/sites/overview': 'InsForge cloud site hosting / deployments',
  'core-concepts/analytics/overview': 'PostHog integration, not available on Mojobase',
  'core-concepts/webscraper/overview': 'Apify integration, not available on Mojobase',
  'integrations/better-auth': 'flow depends entirely on the InsForge CLI scaffold',
  'agent-native/overview': 'InsForge CLI',
  'agent-native/cli-harness': 'InsForge CLI',
  'agent-native/diagnostics': 'InsForge CLI (diagnose)',
  'agent-native/config-as-code': 'InsForge CLI (config plan/apply)',
  'agent-native/branching': 'InsForge Cloud branching via CLI',
  'agent-native/vscode-extension': 'InsForge VS Code extension (signs in to InsForge Cloud)',
  'deployment/self-host-storage': 'self-hosting InsForge',
  'deployment/telemetry': 'self-hosting InsForge',
  'deployment/deployment-security-guide': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-aws-ec2': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-azure-virtual-machines': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-containarium': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-coolify': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-dokploy': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-google-cloud-compute-engine': 'self-hosting InsForge (no source page)',
  'deployment/deploy-to-hetzner': 'self-hosting InsForge (no source page)',
  'asset-guidelines': 'InsForge brand asset guidelines',
};

// Pages written for Mojobase (content/pages/<slug>.mdx) replace or add to upstream.
export const OVERRIDES = [
  'introduction',
  'products',
  'quickstart',
  'mcp-setup',
  'faq',
  'core-concepts/database/migrations',
  'core-concepts/database/backups',
  'core-concepts/database/connection-string',
];

// Pages to insert into the nav: [afterSlug, newSlug]
export const NAV_INSERT = [
  ['core-concepts/database/overview', 'core-concepts/database/connection-string'],
];

// Groups dropped from nav (when all their pages are gone they vanish anyway).
export const NAV_RENAME = { Resources: null };

const MOJOBASE_KEYS = `Create a project in the [Mojobase console](https://mojobase.dev), or open an existing one. Its **Connect** panel shows the **Project URL**, the **Anon key** (\`anon_...\`) and the admin **API key** (\`ik_...\`).

Then read your project's JWT secret with the admin API key (run this server-side, never in the browser):

\`\`\`bash
curl https://your-project.insforge.app/api/secrets/JWT_SECRET \\
  -H "Authorization: Bearer ik_your_api_key"
# => { "key": "JWT_SECRET", "value": "..." }
\`\`\``;

const QUICKSTART_LINE =
  '- Follow the [Quickstart](/quickstart) to create a project and connect your app or coding agent.';

// Patches applied to every page.
export const GLOBAL_PATCHES = [
  [/- Set up the \[CLI\]\(\/quickstart\)[^\n]*/g, QUICKSTART_LINE],
  [/ \(self-hosted or cloud\)/g, ''],
  [/- \[Live Demo\]\([^)]*\)[^\n]*\n/g, ''],
  [/- \[Source Code\]\(https:\/\/github\.com\/InsForge\/insforge-integration[^)]*\)[^\n]*\n/g, ''],
  [/ with the CLI and MCP,/g, ' over MCP,'],
  [
    /Find the anon key with `npx @insforge\/cli secrets get ANON_KEY`, or in the dashboard: click \*\*Install\*\* and open \*\*API Keys\*\*\./g,
    "Find the project URL and anon key in your project's **Connect** panel in the [Mojobase console](https://mojobase.dev).",
  ],
  // framework guides
  [
    /- \*\*CLI link\*\* — see the \[Quickstart\]\(\/quickstart\)[^\n]*/g,
    '- **Project keys** — create a project in the [Mojobase console](https://mojobase.dev) and copy the URL and anon key from its **Connect** panel, or paste its **AI prompt** into your agent. See the [Quickstart](/quickstart).',
  ],
  // integrations: project + JWT secret setup
  [
    /Create a new project or link an existing one:\s*```bash[\s\S]*?```\s*Then get your project credentials:\s*```bash[\s\S]*?```/g,
    MOJOBASE_KEYS,
  ],
  [
    /You'll use the JWT Secret from the CLI output in a later step to sign tokens for InsForge\./g,
    "You'll use the JWT secret `value` in a later step to sign tokens for InsForge.",
  ],
  [
    /You'll use the JWT Secret from the CLI output to sign tokens for InsForge\./g,
    "You'll use the JWT secret `value` to sign tokens for InsForge.",
  ],
];

// Per-page patches. Each entry: [find (string|RegExp), replace]. A string
// patch that does not match is reported as a build warning.
export const PATCHES = {
  'core-concepts/database/overview': [
    [
      'applied with `npx @insforge/cli db migrations up --all` or via the MCP tool.',
      'applied through the migrations API, the SQL editor, or your agent over MCP.',
    ],
    [/### Branching\n\n[^\n]*\n\n/, ''],
  ],
  'core-concepts/functions/overview': [
    [
      'The dashboard, CLI, and MCP all read and write the same store;',
      'The dashboard, the REST API, and MCP all read and write the same store;',
    ],
    [
      /`secrets list` shows only metadata with the values hidden, and `secrets get` returns the decrypted value on demand\. A secret can also carry an expiry date \(`--expires <ISO-8601>`\) and be marked protected from deletion \(`--reserved`\)\./,
      'Listing secrets (`GET /api/secrets`) shows only metadata with the values hidden, and `GET /api/secrets/{key}` returns the decrypted value on demand. A secret can also carry an expiry date (`expiresAt`) and be marked protected from deletion (`isReserved`).',
    ],
    [
      /```bash\n# a protected secret with an expiry\nnpx @insforge\/cli secrets add[^\n]*\n# read the decrypted value back\nnpx @insforge\/cli secrets get[^\n]*\n```/,
      '```bash\n# a protected secret with an expiry (admin API key required)\ncurl -X POST https://your-project.insforge.app/api/secrets \\\n  -H "Authorization: Bearer ik_your_api_key" -H "Content-Type: application/json" \\\n  -d \'{"key":"STRIPE_SECRET_KEY","value":"sk_live_xxx","isReserved":true,"expiresAt":"2027-01-01T00:00:00Z"}\'\n\n# read the decrypted value back\ncurl https://your-project.insforge.app/api/secrets/STRIPE_SECRET_KEY \\\n  -H "Authorization: Bearer ik_your_api_key"\n```',
    ],
  ],
  'core-concepts/ai/overview': [
    [
      'InsForge holds the provider keys, tracks usage per project, and routes traffic through [OpenRouter](https://openrouter.ai)',
      'Your project holds the provider key, tracks usage per project, and routes traffic through [OpenRouter](https://openrouter.ai)',
    ],
    [
      /(<Frame caption="One OpenAI-compatible endpoint)/,
      '<Note>\n  On Mojobase, add your own OpenRouter API key under **Model Gateway → Settings** in the project dashboard. Managed model credits are not available.\n</Note>\n\n$1',
    ],
    [
      'Query usage from the dashboard, CLI, or MCP',
      'Query usage from the dashboard or the REST API',
    ],
  ],
  'core-concepts/compute/overview': [
    [
      /(<Note>\n  \*\*Just need to handle a request\?\*\*)/,
      '<Warning>\n  Custom Compute must be enabled for your Mojobase project. If the compute endpoints return `503 COMPUTE_NOT_CONFIGURED`, it is not available for your project yet.\n</Warning>\n\n$1',
    ],
    ['    CLI[InsForge CLI] --> Service\n', '    API[REST API] --> Service\n'],
    ['    style CLI fill:', '    style API fill:'],
    [
      /point a service at a public image and it is pulled and started, with no `Dockerfile` or build step\. From the CLI:\n\n```bash\n[\s\S]*?```\n\n`--image` selects image mode \(no `flyctl` or Docker needed\)\. Use `--protocol tcp` for raw-TCP services like Redis; the default `--protocol http` suits HTTP servers\. Re-running `compute deploy` with the same `--name` updates the existing service in place\./,
      'point a service at a public image and it is pulled and started, with no `Dockerfile` or build step. Create it from the dashboard\'s **Compute** page or the REST API:\n\n```bash\ncurl -X POST "$MOJOBASE_URL/api/compute/services/deploy" \\\n  -H "x-api-key: $MOJOBASE_API_KEY" -H \'Content-Type: application/json\' \\\n  -d \'{"name":"cache","image":"redis:7-alpine","port":6379,"memory":512}\'\n```\n\nDeploying again with the same `name` updates the existing service in place.',
    ],
    [
      "When you self-host, compute containers join your project's own network by default, so `postgres:5432` and `postgrest:3000` resolve by name from inside the container exactly as they do for edge functions — no public round trip.\n\n",
      '',
    ],
    ['Tail in the dashboard, CLI, or MCP without', 'Tail them in the dashboard without'],
    [/## Self-hosting: enable compute[\s\S]*?(?=### Building from source)/, ''],
    [/### Platform support[\s\S]*?(?=## Next steps)/, ''],
  ],
  'core-concepts/messaging/overview': [
    [
      /<Warning>\n  \*\*Self-hosting\?\*\*[\s\S]*?<\/Warning>/,
      '<Note>\n  **Email works out of the box.** Every Mojobase project is created with email delivery set up: messages are sent from `no-reply@mojobase.dev` with your project name as the sender name. To send from your own domain, replace it with your provider in [Custom SMTP](/core-concepts/messaging/custom-smtp).\n</Note>',
    ],
    [
      '    Decision -->|No| Cloud[InsForge Cloud]\n    Cloud --> SES[AWS SES]\n',
      '    Decision -->|No| Default[Mojobase sender]\n',
    ],
    ['    SES --> Inbox[Recipient Inbox]\n', '    Default --> Inbox[Recipient Inbox]\n'],
    [
      '    style Cloud fill:#7c3aed,stroke:#a78bfa,color:#ede9fe\n    style SES fill:#ea580c,stroke:#f97316,color:#fed7aa\n',
      '    style Default fill:#7c3aed,stroke:#a78bfa,color:#ede9fe\n',
    ],
    [
      '    Managed SMTP or bring your own provider.',
      '    Built-in sender, or bring your own SMTP provider.',
    ],
    [
      '### Managed delivery or bring your own\n\nSend through InsForge Cloud (AWS SES for email today) for zero setup, or plug in your own provider when you need to control deliverability and sender reputation.',
      "### Built-in sender or bring your own\n\nEvery project starts with Mojobase's sender (`no-reply@mojobase.dev`) for zero setup. Plug in your own SMTP provider (SES, Postmark, Resend, SendGrid, Mailgun, …) when you want your own domain and control over deliverability and sender reputation.",
    ],
    ['Per-project and per-plan limits', 'Per-project limits'],
  ],
  'core-concepts/messaging/custom-smtp': [
    [
      ' A self-hosted instance cannot turn SMTP off while required email verification depends on it.',
      ' SMTP cannot be turned off while required email verification depends on it.',
    ],
    [
      /<Note>\n  \*\*Self-hosted instances need this[\s\S]*?<\/Note>/,
      '<Note>\n  **Optional.** New Mojobase projects come with these settings pre-filled to send from `no-reply@mojobase.dev`. Replace them with your own provider to send from your domain. If you disable SMTP, verification, magic-link and password-reset emails are not delivered.\n</Note>',
    ],
  ],
  'core-concepts/authentication/overview': [
    [
      /<Note>\n  \*\*Self-hosting\?\*\* Sending these emails[\s\S]*?<\/Note>/,
      '<Note>\n  **Email delivery:** verification, password-reset, magic-link and one-time-code emails work out of the box, sent from `no-reply@mojobase.dev` with your project name. Use [Custom SMTP](/core-concepts/messaging/custom-smtp) to send from your own domain.\n</Note>',
    ],
  ],
  'core-concepts/storage/s3-compatibility': [
    [
      ' Available on cloud projects and on self-hosted deployments with an S3-backed storage provider — see [Self-hosted storage](/deployment/self-host-storage).',
      '\n\n<Note>\n  The S3 gateway needs an S3-backed storage provider. If **Storage → Settings → S3 Configuration** is not shown for your project, the gateway is not enabled for it; use the REST API or SDK instead.\n</Note>',
    ],
  ],
  'core-concepts/payments/stripe': [
    [
      /Configure `test` and `live` Stripe secret keys in Dashboard -> Payments -> Settings, the CLI, or the admin API\.\n\n```bash\n[\s\S]*?```/,
      'Configure `test` and `live` Stripe secret keys in Dashboard -> Payments -> Settings, or through the admin API.',
    ],
  ],
  'sdks/typescript/payments-stripe': [
    [
      /Configure them from the dashboard or CLI before using the SDK\.\n\n```bash\n[\s\S]*?```/,
      'Configure them from the dashboard (**Payments → Settings**) before using the SDK.',
    ],
    [
      'Configure Stripe keys through the InsForge dashboard or CLI.',
      'Configure Stripe keys through the Mojobase dashboard.',
    ],
  ],
  'sdks/typescript/email': [
    [
      /By default, emails are sent from `noreply@<your-project>\.send\.insforge\.dev`, a per-project subdomain that InsForge Cloud provisions and verifies for you, so no domain setup is required\. The `from` field only sets the display name shown next to that address; on the default provider you cannot change the address or domain\. To send from your own domain, configure \[Custom SMTP\]\(\/core-concepts\/messaging\/custom-smtp\)\. When Custom SMTP is enabled/,
      "Mojobase projects send email through the project's SMTP settings, which start out configured with Mojobase's sender (`no-reply@mojobase.dev`). To send from your own domain, change them in [Custom SMTP](/core-concepts/messaging/custom-smtp). Because SMTP is used,",
    ],
  ],
  'sdks/typescript/database': [
    [
      'Combine database queries with `useUser()` or `useAuth()` hooks to fetch user-specific data:',
      'Combine database queries with the signed-in user from `auth.getCurrentUser()` to fetch user-specific data:',
    ],
    [
      `import { useUser } from '@insforge/react'; // or '@insforge/react-router'
import { insforge } from './lib/insforge';
import { useEffect, useState } from 'react';

function MyProfile() {
  const { user, isLoaded } = useUser();
  const [posts, setPosts] = useState([]);
`,
      `import { insforge } from './lib/insforge';
import { useEffect, useState } from 'react';

function MyProfile() {
  const [user, setUser] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [posts, setPosts] = useState([]);

  useEffect(() => {
    insforge.auth.getCurrentUser().then(({ data }) => {
      setUser(data?.user ?? null);
      setIsLoaded(true);
    });
  }, []);
`,
    ],
  ],
  'sdks/rest/database': [
    [
      ' The InsForge CLI generates 14-digit UTC timestamps for local migration filenames.',
      ' A 14-digit UTC timestamp (`YYYYMMDDHHmmss`) is a good default.',
    ],
  ],
  'sdks/rest/functions': [
    [
      'Invoke and manage serverless edge functions over HTTP with the InsForge REST API, running on Deno Subhosting in the cloud or locally in Docker.',
      "Invoke and manage serverless edge functions over HTTP with the InsForge REST API, running on your project's Deno runtime.",
    ],
    [
      'In cloud environments, functions run on Deno Subhosting at the edge. In self-hosted (Docker) environments, functions run in a local Deno runtime.',
      "Functions run in your project's Deno runtime.",
    ],
    [
      '(self-hosted: local Deno runtime down; cloud: subhosting proxy failure)',
      '(for example, the Deno runtime is restarting)',
    ],
  ],
  'sdks/rest/auth': [
    [
      'Exchange a cloud provider authorization code for an admin session.',
      'Exchange a dashboard authorization code for an admin session. This is used by the embedded project dashboard; apps should not need it.',
    ],
    [
      'Authorization code or JWT from Insforge Cloud',
      'Authorization code or JWT issued by the Mojobase console',
    ],
  ],
  'examples/overview': [
    [
      /### Community showcase[\s\S]*$/,
      '## More\n\n- [Quickstart](/quickstart) to create a project and connect your agent.\n- [MCP setup](/mcp-setup) to let your coding agent manage the backend.\n- Questions or ideas? Open an issue on [GitHub](https://github.com/InsForge/InsForge).\n',
    ],
  ],
  'integrations/clerk': [
    [
      /To find your \*\*Project URL\*\* and \*\*Anon Key\*\*, open your project[^\n]*\n\n!\[[^\n]*\n\n/,
      '',
    ],
    [
      /The CLI prints the JWT Secret as `JWT_SECRET=<value>`[^\n]*\n/,
      "You'll use the JWT secret `value` when creating the Clerk JWT Template in the next step.\n",
    ],
    [
      '   - Paste **only the value**, not the `JWT_SECRET=` prefix. For example, if the CLI output is `JWT_SECRET=a1b2c3d4e5f6...`, paste only `a1b2c3d4e5f6...`.',
      '   - Paste **only the secret value** (the `value` field from the response above), without quotes.',
    ],
  ],
};
