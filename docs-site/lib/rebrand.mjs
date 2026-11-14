// Text-level rebranding: InsForge -> Mojobase.
//
// Runs on the MDX source (prose AND code) after per-page patches. A few
// identifiers are protected because they are real names Mojobase does not
// change:
//   * native SDK packages Mojobase does not republish (Swift / Kotlin), and
//   * wire-level names baked into the backend (OAuth/email redirect query
//     params, Stripe metadata keys, the admin refresh cookie, and the
//     INSFORGE_* secrets injected into edge functions).

export const MOJOBASE_REPO = 'https://github.com/zainulabedeen123/mojobase';
export const CONSOLE = 'https://mojobase.dev';
export const PROJECT_URL = 'https://your-project.mojobase.dev';

// Order matters: the most specific patterns first.
const PROTECT = [
  // local image paths are resolved against the upstream files (renamed on copy)
  /\/images\/[\w/.%-]+/g,
  // Swift SDK
  /https:\/\/github\.com\/insforge\/insforge-swift(?:\.git)?/g,
  /\bimport InsForge\b/g,
  /\bInsForge(?:Client(?:Options)?|AuthError|Error)\b/g,
  /pod 'InsForge'/g,
  // Kotlin SDK
  /https:\/\/maven\.pkg\.github\.com\/InsForge\/insforge-kotlin/g,
  /\bdev\.insforge(?:[.:][\w.:-]*)?/g,
  /\bcreateInsforgeClient\b/g,
  /\bInsforge(?:Http)?Exception\b/g,
  /\bInsforgeLogLevel\b/g,
  // wire-level identifiers that really exist on the server
  /\binsforge_(?:status|type|error|code|subject_type|subject_id|admin_refresh_token)\b/g,
  /`insforge_`/g,
  /Deno\.env\.get\(\s*['"]INSFORGE_[A-Z_]+['"]\s*\)/g,
  /\bINSFORGE_INTERNAL_URL\b/g,
  /:\d+\/insforge\?sslmode/g,
  /\/insforge\?sslmode/g,
];

const LINK_DROP = [
  /^https?:\/\/(?:www\.)?discord\.(?:com|gg)\//i,
  /^https?:\/\/(?:x|twitter)\.com\//i,
  /^https?:\/\/(?:www\.)?linkedin\.com\//i,
  /^https?:\/\/[\w-]+\.insforge\.site/i,
  /^https?:\/\/calendly\.com\//i,
  /^https?:\/\/(?:www\.)?npmjs\.com\/package\/@insforge\/cli/i,
  /^https?:\/\/(?:marketplace\.visualstudio\.com|open-vsx\.org)\/.*insforge/i,
  /^https?:\/\/agents\.insforge\.dev/i,
  /^https?:\/\/insforge\.dev\/(?:pricing|changelogs|skill\.md|alternatives)/i,
];

// Map a single URL. Returns null to drop the link (keep the text).
export function mapUrl(url) {
  if (!url) return url;
  if (LINK_DROP.some((r) => r.test(url))) return null;
  let m;
  if ((m = /^https?:\/\/docs\.insforge\.dev(\/[^\s)]*)?$/i.exec(url))) return m[1] || '/';
  if (/^https?:\/\/github\.com\/InsForge\/InsForge(?:\/(?:issues|pulls)?\/?)?$/i.test(url))
    return MOJOBASE_REPO;
  if (/^https?:\/\/github\.com\/InsForge\/insforge-(?:swift|kotlin)/i.test(url)) return url;
  if (/^https?:\/\/github\.com\/InsForge\//i.test(url)) return null;
  if (/^https?:\/\/mcp\.insforge\.dev\/mcp/i.test(url)) return `${CONSOLE}/mcp`;
  if (/^https?:\/\/(?:www\.)?insforge\.dev\/agents/i.test(url)) return `${CONSOLE}/agents`;
  if (/^https?:\/\/(?:www\.)?insforge\.dev(?:\/.*)?$/i.test(url)) return CONSOLE;
  return url;
}

export function rebrand(text) {
  const saved = [];
  const hold = (s) => {
    saved.push(s);
    return `\u0000${saved.length - 1}\u0000`;
  };
  let t = text;
  for (const re of PROTECT) t = t.replace(re, (m) => hold(m));

  // Markdown links: map or drop.
  t = t.replace(/\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) => {
    const mapped = mapUrl(url);
    if (mapped === null) return label;
    return `[${label}](${mapped})`;
  });
  // href="..." attributes on Cards / anchors
  t = t.replace(/href="(https?:\/\/[^"]+)"/g, (m, url) => {
    const mapped = mapUrl(url);
    return mapped === null ? '' : `href="${mapped}"`;
  });

  // Project URLs (any form) -> your-project.mojobase.dev
  t = t.replace(
    /https?:\/\/(?:<project>|<your-project>|<project-ref>|[\w-]+)(?:\.[\w-]+)?\.(?:functions\.)?insforge\.(?:app|dev)(?=[/'"`\s)\],:;]|$)/gi,
    (m) => {
      if (
        /\/\/(?:mcp|api|docs|www|agents|b)\.insforge\.dev/i.test(m) ||
        /\/\/insforge\.dev/i.test(m)
      )
        return m;
      const sub = /\/\/([^.]+)/.exec(m)[1];
      if (/^project2$/i.test(sub)) return 'https://your-other-project.mojobase.dev';
      if (/functions\.insforge/i.test(m)) return `${PROJECT_URL}/functions`;
      return PROJECT_URL;
    }
  );
  t = t.replace(/\b[\w-]+\.(?:us-east|region)\.insforge\.app\b/g, 'your-project.mojobase.dev');
  // remaining bare hosts
  t = t.replace(/https?:\/\/mcp\.insforge\.dev\/mcp/gi, `${CONSOLE}/mcp`);
  t = t.replace(/https?:\/\/(?:www\.)?insforge\.dev\b\/?/gi, CONSOLE);
  t = t.replace(/\b(?:www\.)?insforge\.dev\b/gi, 'mojobase.dev');

  // npm packages Mojobase republishes
  t = t.replace(/@insforge\/(sdk|mcp|install)\b/g, '@mojobase/$1');

  // Names
  t = t.replace(/\b([Aa])n (InsForge|Insforge)\b/g, '$1 $2');
  t = t.replace(/InsForge Cloud/g, 'Mojobase');
  t = t.replace(/Insforge Cloud/g, 'Mojobase');
  t = t.replace(/INSFORGE/g, 'MOJOBASE');
  t = t.replace(/InsForge|Insforge/g, 'Mojobase');
  t = t.replace(/insForge/g, 'mojobase');
  t = t.replace(/insforge/g, 'mojobase');

  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => saved[Number(i)]);
  return t;
}
