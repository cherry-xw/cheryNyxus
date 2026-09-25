/*
 * Small Markdown reader used by the repository documentation checks.
 *
 * This is deliberately not a Markdown renderer. It only understands the
 * syntax needed to validate local links and heading anchors without pulling
 * a website renderer into the repository toolchain.
 */

function unquote(line) {
  return line.replace(/^\s*(?:>\s*)+/, '');
}

export function withoutFencedCode(markdown) {
  let fence = null;
  return String(markdown)
    .split(/\r?\n/)
    .map((line) => {
      const plain = unquote(line);
      const match = plain.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) {
          fence = null;
        }
        return '';
      }
      if (match) {
        fence = match[1];
        return '';
      }
      return line;
    })
    .join('\n');
}

function removeInlineCode(text) {
  return text.replace(/(`+)([\s\S]*?)\1/g, (match) => ' '.repeat(match.length));
}

function unescapeMarkdown(value) {
  return value.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1');
}

function labelKey(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function destination(value) {
  return unescapeMarkdown(value.replace(/^<|>$/g, ''));
}

const REFERENCE = /^\s{0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;

export function collectReferences(markdown) {
  const references = new Map();
  for (const line of withoutFencedCode(markdown).split('\n')) {
    const match = unquote(line).match(REFERENCE);
    if (match && !references.has(labelKey(match[1]))) {
      references.set(labelKey(match[1]), destination(match[2]));
    }
  }
  return references;
}

export function extractLinks(markdown) {
  const clean = removeInlineCode(withoutFencedCode(markdown));
  const references = collectReferences(markdown);
  const links = [];
  const linkPattern = /(?<!!)\[([^\]\n]+)\](?:\(\s*(<[^>\n]+>|(?:\\.|[^\s()\\]|\([^()\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|\[([^\]\n]*)\])/g;

  for (const match of clean.matchAll(linkPattern)) {
    const href = match[2]
      ? destination(match[2])
      : references.get(labelKey(match[3] || match[1]));
    if (href === undefined && match[3] === undefined) continue;
    links.push({
      text: match[1],
      href: href ?? null,
      index: match.index ?? 0,
    });
  }
  return links;
}

function headingText(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1')
    .trim();
}

export function headingSlug(value) {
  return headingText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
    .replace(/\s+/g, '-');
}

export function collectAnchors(markdown) {
  const anchors = new Set();
  const used = new Map();
  const clean = withoutFencedCode(markdown);

  for (const line of clean.split('\n')) {
    const explicit = [...line.matchAll(/<a\s+[^>]*id=["']([^"']+)["'][^>]*>/giu)];
    for (const match of explicit) anchors.add(match[1]);

    const heading = unquote(line).match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;

    const base = headingSlug(heading[1]);
    if (!base) continue;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

export function isExternalHref(href) {
  return /^(?:https?:|mailto:|tel:|data:|javascript:|#|\/\/)/iu.test(href);
}

export function splitHref(href) {
  const hash = href.indexOf('#');
  if (hash < 0) return { path: href, fragment: '' };
  return { path: href.slice(0, hash), fragment: href.slice(hash + 1) };
}
