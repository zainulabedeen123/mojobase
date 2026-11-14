// Minimal MDX (Mintlify flavour) -> HTML renderer.
//
// The docs use a small, known set of JSX components on top of Markdown. We
// split each page into a tree of {text | element} nodes (skipping fenced code
// and inline code so generics like `Map<String, Any>` are left alone), render
// text with `marked`, and render each component to static HTML. Everything
// interactive (tabs, copy buttons, search) is driven by the external docs.js.

import { Marked } from 'marked';
import hljs from 'highlight.js';

// Components we understand. Anything else that looks like a tag in prose is
// escaped and shown literally (e.g. placeholders such as <your-project-id>).
const COMPONENTS = new Set([
  'Card',
  'CardGroup',
  'Columns',
  'Note',
  'Tip',
  'Warning',
  'Info',
  'Check',
  'Danger',
  'Tabs',
  'Tab',
  'CodeGroup',
  'Steps',
  'Step',
  'Accordion',
  'AccordionGroup',
  'Frame',
  'ParamField',
  'ResponseField',
  'Expandable',
  'Tooltip',
  'Badge',
  'Icon',
  'Visibility',
  'Update',
  'Panel',
  'RequestExample',
  'ResponseExample',
  // raw HTML used inside MDX
  'img',
  'video',
  'div',
  'br',
  'span',
  'a',
  'iframe',
  'source',
]);
const VOID = new Set(['img', 'br', 'source']);

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/&[a-z]+;/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'section'
  );
}

// ------------------------------------------------------------------ tokenizer

function parseAttrs(src) {
  const attrs = {};
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    const m = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(i));
    if (!m) {
      i++;
      continue;
    }
    const name = m[0];
    i += name.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '=') {
      attrs[name] = true;
      continue;
    }
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q === '"' || q === "'") {
      const end = src.indexOf(q, i + 1);
      attrs[name] = src.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? src.length : end + 1;
    } else if (q === '{') {
      let depth = 0,
        j = i;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      let expr = src.slice(i + 1, j).trim();
      // {2} -> 2, {"x"} -> x, {true} -> true; leave objects/arrays as raw text
      if (/^-?\d+(\.\d+)?$/.test(expr)) expr = Number(expr);
      else if (/^(["'`]).*\1$/s.test(expr)) expr = expr.slice(1, -1);
      else if (expr === 'true' || expr === 'false') expr = expr === 'true';
      attrs[name] = expr;
      i = j + 1;
    } else {
      const m2 = /^[^\s>]+/.exec(src.slice(i));
      attrs[name] = m2 ? m2[0] : '';
      i += m2 ? m2[0].length : 1;
    }
  }
  return attrs;
}

// Read a tag starting at src[i] === '<'. Returns null if it is not a known component.
function readTag(src, i) {
  const m = /^<(\/?)([A-Za-z][\w.]*)/.exec(src.slice(i, i + 64));
  if (!m) return null;
  const closing = m[1] === '/';
  const name = m[2];
  if (!COMPONENTS.has(name)) return null;
  // find end of tag, honouring quotes and {} expressions
  let j = i + m[0].length,
    depth = 0,
    quote = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) {
      quote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  if (j >= src.length) return null;
  let inner = src.slice(i + m[0].length, j);
  let selfClosing = false;
  if (inner.trimEnd().endsWith('/')) {
    selfClosing = true;
    inner = inner.trimEnd().slice(0, -1);
  }
  if (VOID.has(name)) selfClosing = true;
  return { name, closing, selfClosing, attrs: closing ? {} : parseAttrs(inner), end: j + 1 };
}

export function tokenize(src) {
  const root = { type: 'el', name: 'root', attrs: {}, children: [] };
  const stack = [root];
  let buf = '';
  const flush = () => {
    if (buf) stack[stack.length - 1].children.push({ type: 'text', value: buf });
    buf = '';
  };
  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    // fenced code: copy verbatim
    if (atLineStart) {
      const fm = /^([ \t]*)(```+|~~~+)[^\n]*\n?/.exec(src.slice(i));
      if (fm) {
        const fence = fm[2];
        let j = i + fm[0].length;
        const closeRe = new RegExp('^[ \\t]*' + fence[0] + '{' + fence.length + ',}[ \\t]*$', 'm');
        const rest = src.slice(j);
        const cm = closeRe.exec(rest);
        const endIdx = cm ? j + cm.index + cm[0].length : src.length;
        buf += src.slice(i, endIdx);
        i = endIdx;
        atLineStart = false;
        continue;
      }
    }
    const c = src[i];
    if (c === '`') {
      const run = /^`+/.exec(src.slice(i))[0];
      const close = src.indexOf(run, i + run.length);
      const nl = src.indexOf('\n\n', i);
      if (close > 0 && (nl < 0 || close < nl)) {
        buf += src.slice(i, close + run.length);
        i = close + run.length;
        atLineStart = false;
        continue;
      }
    }
    if (c === '{' && src.startsWith('{/*', i)) {
      const end = src.indexOf('*/}', i);
      if (end > 0) {
        i = end + 3;
        continue;
      }
    }
    if (c === '<') {
      const t = readTag(src, i);
      if (t) {
        flush();
        if (t.closing) {
          // pop to the matching element
          for (let k = stack.length - 1; k > 0; k--) {
            if (stack[k].name === t.name) {
              stack.length = k;
              break;
            }
          }
        } else {
          const el = { type: 'el', name: t.name, attrs: t.attrs, children: [] };
          stack[stack.length - 1].children.push(el);
          if (!t.selfClosing) stack.push(el);
        }
        i = t.end;
        atLineStart = false;
        continue;
      }
    }
    buf += c;
    atLineStart = c === '\n';
    i++;
  }
  flush();
  return root;
}

// ------------------------------------------------------------------ helpers

function dedent(text) {
  const lines = text.split('\n');
  let min = Infinity;
  lines.forEach((l, idx) => {
    if (idx === 0 && !text.startsWith('\n') && l.trim()) {
      // first line continues after a tag; ignore for indent purposes
      return;
    }
    if (!l.trim()) return;
    const ind = /^[ \t]*/.exec(l)[0].length;
    if (ind < min) min = ind;
  });
  if (!isFinite(min) || min === 0)
    return lines.map((l, idx) => (idx === 0 ? l.trimStart() : l)).join('\n');
  return lines
    .map((l, idx) =>
      idx === 0 ? l.trimStart() : l.slice(Math.min(min, /^[ \t]*/.exec(l)[0].length))
    )
    .join('\n');
}

// Escape stray "<" in prose (not in code) so placeholders like <your-id> show.
function escapeStrayTags(md) {
  const out = [];
  const lines = md.split('\n');
  let inFence = null;
  for (const line of lines) {
    const fm = /^\s*(```+|~~~+)/.exec(line);
    if (inFence) {
      out.push(line);
      if (
        fm &&
        fm[1][0] === inFence[0] &&
        fm[1].length >= inFence.length &&
        line.trim().replace(/[`~]/g, '') === ''
      )
        inFence = null;
      continue;
    }
    if (fm) {
      inFence = fm[1];
      out.push(line);
      continue;
    }
    // split by inline code spans
    out.push(
      line.replace(/(`+)([\s\S]*?)\1|<(?!br\s*\/?>|https?:\/\/)/g, (m, tick) => (tick ? m : '&lt;'))
    );
  }
  return out.join('\n');
}

const GLYPHS = {
  database: '◫',
  shield: '⛨',
  lock: '⛨',
  folder: '▤',
  'cloud-arrow-up': '▤',
  sparkles: '✦',
  brain: '✦',
  bolt: '⚡',
  'tower-broadcast': '◉',
  'signal-stream': '◉',
  server: '▦',
  globe: '◍',
  envelope: '✉',
  'credit-card': '▭',
  plug: '⌁',
  terminal: '›_',
  code: '</>',
  js: 'JS',
  swift: '◆',
  android: '◆',
  react: '⚛',
  vuejs: 'V',
  n: 'N',
  star: '★',
  github: '◆',
  key: '⚿',
  robot: '◈',
  message: '✉',
  bell: '◔',
  book: '▯',
  rocket: '➚',
  'circle-question': '?',
  'file-code': '</>',
  link: '⌁',
};

// ------------------------------------------------------------------ renderer

export function createRenderer({ resolveHref, resolveImage, onHeading }) {
  let codeId = 0;
  const renderCode = (code, info) => {
    const parts = String(info || '')
      .trim()
      .split(/\s+/);
    let lang = (parts[0] || '').toLowerCase();
    let title = parts.slice(1).join(' ');
    // Mintlify allows ```bash npm  or ```typescript lib/file.ts
    if (
      lang &&
      !hljs.getLanguage(lang) &&
      !['mermaid', 'text', 'plaintext', 'txt', 'env', 'dotenv'].includes(lang)
    ) {
      if (!title) title = parts[0];
      lang = '';
    }
    let html;
    const aliases = {
      env: 'bash',
      dotenv: 'bash',
      sh: 'bash',
      shell: 'bash',
      zsh: 'bash',
      jsonc: 'json',
      tsx: 'typescript',
      jsx: 'javascript',
    };
    const hl = aliases[lang] || lang;
    if (
      hl &&
      hl !== 'mermaid' &&
      hl !== 'text' &&
      hl !== 'plaintext' &&
      hl !== 'txt' &&
      hljs.getLanguage(hl)
    ) {
      html = hljs.highlight(code, { language: hl, ignoreIllegals: true }).value;
    } else {
      html = escapeHtml(code);
    }
    const label = title || (lang === 'mermaid' ? 'Diagram (Mermaid)' : lang || 'text');
    codeId++;
    return (
      `<div class="code-block${lang === 'mermaid' ? ' is-mermaid' : ''}">` +
      `<div class="code-head"><span class="code-title">${escapeHtml(label)}</span>` +
      `<button class="copy-btn" type="button" aria-label="Copy code">Copy</button></div>` +
      `<pre><code class="hljs${hl ? ' language-' + escapeHtml(hl) : ''}">${html}</code></pre></div>`
    );
  };

  const marked = new Marked({ gfm: true, breaks: false });
  let collectToc = true;
  marked.use({
    renderer: {
      code({ text, lang }) {
        return renderCode(text, lang);
      },
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = inner
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
        const id = onHeading(plain, depth, collectToc);
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const target = resolveHref(href);
        if (target === null) return inner;
        const ext = /^https?:/.test(target);
        return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}${ext ? ' rel="noopener" target="_blank"' : ''}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const src = resolveImage(href);
        if (!src) return '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy">`;
      },
      table(token) {
        // default table rendering wrapped for horizontal scrolling
        let header = '';
        for (const cell of token.header) header += this.tablecell(cell);
        let body = '';
        for (const row of token.rows) {
          let r = '';
          for (const cell of row) r += this.tablecell(cell);
          body += `<tr>${r}</tr>`;
        }
        return `<div class="table-wrap"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>\n`;
      },
      html({ text }) {
        // raw HTML that reached marked is never trusted: show it as text
        if (/^\s*<br\s*\/?>\s*$/i.test(text)) return '<br>';
        return escapeHtml(text);
      },
    },
  });

  const md = (text, inComponent) => {
    const prev = collectToc;
    collectToc = !inComponent;
    const out = marked.parse(escapeStrayTags(dedent(text)));
    collectToc = prev;
    return out;
  };
  const mdInline = (text) => marked.parseInline(escapeStrayTags(String(text)));

  function renderChildren(node, inComponent) {
    let out = '';
    // Merge consecutive text nodes, render each run with marked.
    for (const ch of node.children) {
      if (ch.type === 'text') {
        if (ch.value.trim()) out += md(ch.value, inComponent);
      } else out += renderEl(ch);
    }
    return out;
  }

  function callout(kind, node) {
    const icons = { note: 'i', info: 'i', tip: '✓', check: '✓', warning: '!', danger: '!' };
    return `<div class="callout callout-${kind}"><span class="callout-icon" aria-hidden="true">${icons[kind]}</span><div class="callout-body">${renderChildren(node, true)}</div></div>`;
  }

  function textOf(node) {
    return node.children.map((c) => (c.type === 'text' ? c.value : textOf(c))).join('');
  }

  function renderEl(node) {
    const a = node.attrs;
    switch (node.name) {
      case 'Note':
        return callout('note', node);
      case 'Info':
        return callout('info', node);
      case 'Tip':
        return callout('tip', node);
      case 'Check':
        return callout('check', node);
      case 'Warning':
        return callout('warning', node);
      case 'Danger':
        return callout('danger', node);
      case 'CardGroup':
      case 'Columns': {
        const cols = Math.max(1, Math.min(4, Number(a.cols) || 2));
        return `<div class="card-group cols-${cols}">${renderChildren(node, true)}</div>`;
      }
      case 'Card': {
        let href = a.href ? resolveHref(String(a.href)) : null;
        const tag = href ? 'a' : 'div';
        let icon = '';
        if (typeof a.icon === 'string' && a.icon) {
          if (a.icon.startsWith('/')) {
            const src = resolveImage(a.icon);
            if (src)
              icon = `<span class="card-icon"><img src="${escapeHtml(src)}" alt="" loading="lazy"></span>`;
          } else {
            icon = `<span class="card-icon" aria-hidden="true">${escapeHtml(GLYPHS[a.icon] || '•')}</span>`;
          }
        }
        const body = renderChildren(node, true);
        const ext = href && /^https?:/.test(href);
        return `<${tag} class="card${href ? ' is-link' : ''}"${href ? ` href="${escapeHtml(href)}"` : ''}${ext ? ' rel="noopener" target="_blank"' : ''}>${icon}<span class="card-title">${mdInline(a.title || '')}</span>${body ? `<div class="card-body">${body}</div>` : ''}</${tag}>`;
      }
      case 'Steps': {
        const steps = node.children.filter((c) => c.type === 'el' && c.name === 'Step');
        return `<ol class="steps">${steps.map((s) => `<li class="step"><div class="step-title">${mdInline(s.attrs.title || '')}</div><div class="step-body">${renderChildren(s, true)}</div></li>`).join('')}</ol>`;
      }
      case 'Step':
        return `<div class="step-loose"><div class="step-title">${mdInline(a.title || '')}</div>${renderChildren(node, true)}</div>`;
      case 'AccordionGroup':
        return `<div class="accordion-group">${renderChildren(node, true)}</div>`;
      case 'Accordion':
      case 'Expandable':
        return `<details class="accordion"${a.defaultOpen ? ' open' : ''}><summary>${mdInline(a.title || 'Details')}</summary><div class="accordion-body">${renderChildren(node, true)}</div></details>`;
      case 'Tabs': {
        const tabs = node.children.filter((c) => c.type === 'el' && c.name === 'Tab');
        const id = 't' + ++codeId;
        return (
          `<div class="tabs" data-tabs>` +
          `<div class="tab-list" role="tablist">${tabs.map((t, k) => `<button class="tab" type="button" role="tab" id="${id}-tab-${k}" aria-controls="${id}-panel-${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">${mdInline(t.attrs.title || 'Tab ' + (k + 1))}</button>`).join('')}</div>` +
          tabs
            .map(
              (t, k) =>
                `<div class="tab-panel" role="tabpanel" id="${id}-panel-${k}" aria-labelledby="${id}-tab-${k}"${k === 0 ? '' : ' hidden'}>${renderChildren(t, true)}</div>`
            )
            .join('') +
          `</div>`
        );
      }
      case 'Tab':
        return renderChildren(node, true);
      case 'CodeGroup':
      case 'RequestExample':
      case 'ResponseExample': {
        const src = dedent(textOf(node));
        const blocks = [];
        const re = /^[ \t]*(```+)([^\n]*)\n([\s\S]*?)\n[ \t]*\1[ \t]*$/gm;
        let m;
        while ((m = re.exec(src))) blocks.push({ info: m[2].trim(), code: m[3] });
        if (!blocks.length) return renderChildren(node, true);
        const id = 'g' + ++codeId;
        const titleOf = (b) => {
          const p = b.info.split(/\s+/);
          return p.slice(1).join(' ') || p[0] || 'Code';
        };
        return (
          `<div class="tabs code-group" data-tabs>` +
          `<div class="tab-list" role="tablist">${blocks.map((b, k) => `<button class="tab" type="button" role="tab" id="${id}-tab-${k}" aria-controls="${id}-panel-${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}">${escapeHtml(titleOf(b))}</button>`).join('')}</div>` +
          blocks
            .map(
              (b, k) =>
                `<div class="tab-panel" role="tabpanel" id="${id}-panel-${k}" aria-labelledby="${id}-tab-${k}"${k === 0 ? '' : ' hidden'}>${renderCode(b.code, b.info.split(/\s+/)[0])}</div>`
            )
            .join('') +
          `</div>`
        );
      }
      case 'Frame': {
        const inner = renderChildren(node, true).trim();
        if (!inner || !/<img/.test(inner)) return '';
        return `<figure class="frame">${inner}${a.caption ? `<figcaption>${mdInline(a.caption)}</figcaption>` : ''}</figure>`;
      }
      case 'img': {
        const src = resolveImage(String(a.src || ''));
        if (!src) return '';
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(a.alt || '')}" loading="lazy">`;
      }
      case 'video':
      case 'iframe':
      case 'source':
      case 'Visibility':
      case 'Icon':
        return '';
      case 'br':
        return '<br>';
      case 'Badge':
        return `<span class="badge">${escapeHtml(textOf(node))}</span>`;
      case 'Tooltip':
        return `<span class="tooltip" title="${escapeHtml(a.tip || '')}">${mdInline(textOf(node))}</span>`;
      case 'ParamField':
      case 'ResponseField': {
        const name = a.path || a.query || a.body || a.header || a.name || '';
        return `<div class="field"><div class="field-head"><code class="field-name">${escapeHtml(name)}</code>${a.type ? `<span class="field-type">${escapeHtml(a.type)}</span>` : ''}${a.required ? '<span class="field-req">required</span>' : ''}${a.default !== undefined ? `<span class="field-type">default: ${escapeHtml(a.default)}</span>` : ''}</div><div class="field-body">${renderChildren(node, true)}</div></div>`;
      }
      case 'div':
      case 'span':
      case 'Panel':
      case 'Update':
        if (a['aria-hidden'] || a['data-for-agents']) return '';
        return renderChildren(node, true);
      case 'a': {
        const href = a.href ? resolveHref(String(a.href)) : null;
        const inner = mdInline(textOf(node));
        return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
      }
      default:
        return renderChildren(node, true);
    }
  }

  return {
    render(src) {
      const tree = tokenize(src);
      return renderChildren(tree, false);
    },
  };
}
