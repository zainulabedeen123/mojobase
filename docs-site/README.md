# Mojobase docs site

Static generator for the Mojobase documentation served at `https://mojobase.dev/docs`.
It turns the upstream InsForge Mintlify docs in `../docs` into a rebranded, self-contained
HTML site in `../console/public/docs/`.

## Regenerate

```bash
cd docs-site
npm install        # devDependencies only: marked, highlight.js, js-yaml
npm run build      # deletes and recreates ../console/public/docs
npm run check      # link check, CSP check, and a list of remaining "insforge" strings
```

The build prints a warning for every patch that no longer matches upstream, every
leftover `@insforge/cli` reference, and every missing image or unknown link. After
pulling new upstream docs, run the build and fix any warnings in `content/config.mjs`.

## Output

```
console/public/docs/
  index.html                     docs home (the introduction page)
  <slug>/index.html              one page per nav entry, e.g. core-concepts/database/overview
  search-index.json              client-side search index
  assets/docs.css, docs.js       the only stylesheet and script
  assets/logo-*.svg, favicon.svg
  assets/images/...              only the images the rendered pages reference
```

All links are absolute (`/docs/<slug>`, no `.html`). The server must map `/docs/<slug>` to
`/docs/<slug>/index.html`. Pages contain no inline scripts, inline event handlers, or
external resources, so they work under
`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'`.

## How it works

| File | Role |
|---|---|
| `build.mjs` | Reads `../docs/docs.json` (English tabs), filters the nav, loads each page, applies patches, rebrands, renders, writes HTML + search index. |
| `lib/mdx.mjs` | Small MDX renderer: splits pages into Markdown text and Mintlify components (Card, CardGroup, Note/Tip/Warning/Info/Check, Tabs/Tab, CodeGroup, Steps/Step, Accordion/AccordionGroup, Frame, ParamField/ResponseField/Expandable, Tooltip, Badge, Icon, …), renders Markdown with `marked`, and highlights code with `highlight.js` at build time. Mermaid blocks render as labelled code blocks; videos are dropped. |
| `lib/rebrand.mjs` | InsForge → Mojobase text rules (names, `@insforge/sdk|mcp|install`, project URLs, links). Protects the native Swift/Kotlin SDK identifiers and server wire names (`insforge_status`, `insforge_code`, `INSFORGE_INTERNAL_URL`, …) that really exist. |
| `content/config.mjs` | Excluded pages, pages replaced by Mojobase versions, nav insertions, and per-page patches (CLI instructions replaced with console / MCP / REST equivalents). |
| `content/pages/` | Mojobase-specific pages: introduction, products, quickstart, MCP setup, FAQ, migrations, backups, and the new connection-string page. |
| `images/` | Image overrides (dashboard screenshots cropped to remove upstream branding). |
| `assets/` | `docs.css` (console palette, dark by default, light via `prefers-color-scheme`) and `docs.js` (drawer, nav groups, tabs, copy buttons, TOC highlight, search with `/` and Ctrl/Cmd+K). |
| `scripts/check.mjs` | Post-build verification. |

Remaining "InsForge" text in the output is intentional: the footer credit, the native
SDK compatibility note and package identifiers on the Swift/Kotlin pages, server wire
names, and the `insforge` database name inside connection strings.
