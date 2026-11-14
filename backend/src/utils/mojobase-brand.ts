// Mojobase serves the InsForge documentation to agents (MCP fetch-docs, /api/docs).
// Rewrite product names, package names and example URLs so agents install
// @mojobase/* packages and point at *.mojobase.dev. Only for JavaScript/REST and
// general docs: native SDKs (Swift, Kotlin…) keep their real package names.
const RULES: Array<[RegExp, string]> = [
  [/@insforge\/(sdk|mcp|install)\b/g, '@mojobase/$1'],
  [/https?:\/\/docs\.insforge\.dev[^\s)"'>]*/g, 'https://mojobase.dev/docs'],
  [/https?:\/\/(www\.)?insforge\.dev\/dashboard[^\s)"'>]*/g, 'https://mojobase.dev'],
  [
    /https?:\/\/github\.com\/InsForge\/[A-Za-z0-9_.-]+/g,
    'https://github.com/zainulabedeen123/mojobase',
  ],
  [/https?:\/\/(www\.)?insforge\.dev[^\s)"'>]*/g, 'https://mojobase.dev'],
  [/https:\/\/your-app\.(region\.)?insforge\.app/g, 'https://your-project.mojobase.dev'],
  [/\b[a-z0-9{}-]+\.[a-z0-9{}-]+\.insforge\.app\b/g, 'your-project.mojobase.dev'],
  [/\bNEXT_PUBLIC_INSFORGE_/g, 'NEXT_PUBLIC_MOJOBASE_'],
  [/\bVITE_INSFORGE_/g, 'VITE_MOJOBASE_'],
  [/\bINSFORGE_(URL|ANON_KEY|API_KEY|BASE_URL)\b/g, 'MOJOBASE_$1'],
  [/\bconst insforge\b/g, 'const mojobase'],
  [/\binsforge\.(auth|database|storage|functions|realtime|ai|emails|payments)\b/g, 'mojobase.$1'],
  [/\bInsForge Cloud\b/g, 'Mojobase'],
  [/\bInsForge\b|\bInsforge\b/g, 'Mojobase'],
];

export function rebrandDocs(content: string): string {
  return RULES.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    content
  );
}
