/* Shared, dependency-free Markdown subset for the viewer and lint. */
function unquote(line) {
  return line.replace(/^\s*(?:>\s*)+/, '');
}

export function withoutFencedCode(md) {
  let fence = null;
  return String(md).split(/\r?\n/).map((line) => {
    const match = unquote(line).match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return '';
    }
    if (match) {
      fence = match[1];
      return '';
    }
    return line;
  }).join('\n');
}

export function splitTableRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; }
    else if (body[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += body[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function findTables(md) {
  const lines = withoutFencedCode(md).split('\n').map(unquote);
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|') || !/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) || !lines[i + 1].includes('-')) continue;
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].includes('|') && lines[j].trim()) rows.push(splitTableRow(lines[j++]));
    tables.push({ columns: splitTableRow(lines[i]), rows });
    i = j - 1;
  }
  return tables;
}

const REFERENCE = /^\s{0,3}\[([^\]]+)\]:\s*(<[^>\n]+>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;
const labelKey = (label) => label.trim().replace(/\s+/g, ' ').toLowerCase();
const destination = (href) => href.replace(/^<|>$/g, '').replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, '$1');

export function isReferenceDefinition(line) {
  return REFERENCE.test(unquote(line));
}

export function collectReferences(md) {
  const refs = new Map();
  for (const line of withoutFencedCode(md).split('\n')) {
    const match = unquote(line).match(REFERENCE);
    if (match && !refs.has(labelKey(match[1]))) refs.set(labelKey(match[1]), destination(match[2]));
  }
  return refs;
}

/** Offsets allow HTML rendering without interpreting generated markup again.
 * Explicit unresolved references retain href=null so lint can reject them. */
export function extractLinks(text, refs = new Map()) {
  if (isReferenceDefinition(text)) return [];
  const out = [];
  const code = [...text.matchAll(/(`+).*?\1/g)].map((m) => [m.index, m.index + m[0].length]);
  const re = /(?<!!)\[([^\]\n]+)\](?:\(\s*(<[^>\n]+>|(?:\\.|[^\s()\\]|\([^()\n]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|\[([^\]\n]*)\])?/g;
  for (const match of text.matchAll(re)) {
    if (code.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const href = match[2] ? destination(match[2]) : refs.get(labelKey(match[3] || match[1]));
    if (href === undefined && match[3] === undefined) continue;
    out.push({ text: match[1], href: href ?? null, start: match.index, end: match.index + match[0].length });
  }
  return out;
}

export function stripMd(text) {
  return String(text).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`_]/g, '').trim();
}

export function metadataValue(md, label) {
  for (const line of withoutFencedCode(md).split('\n')) {
    const plain = stripMd(unquote(line));
    const match = plain.match(/^([^：:]+)[：:]\s*(.*)$/);
    if (match && match[1].trim() === label) return match[2].trim() || null;
  }
  return null;
}

export function createHeadingSlugger() {
  const used = new Set();
  return (text) => {
    const base = String(text).replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '').replace(/[*`]/g, '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s/g, '-');
    let slug = base;
    for (let suffix = 1; used.has(slug); suffix++) slug = `${base}-${suffix}`;
    used.add(slug);
    return slug;
  };
}
