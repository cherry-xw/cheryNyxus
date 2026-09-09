/* Pure route and request-lifetime helpers; no DOM or browser dependency. */
export function posixJoin(base, rel) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(rel)) return null;
  const out = [];
  for (const part of `${base || ''}/${rel}`.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

export function posixDirname(file) {
  return file.split('/').slice(0, -1).join('/');
}

export function documentHref(currentFile, href) {
  if (/^(?:[a-z][a-z\d+.-]*:|[\/\\])/i.test(href)) return null;
  const at = href.indexOf('#');
  let target, anchor;
  try {
    target = decodeURIComponent(at < 0 ? href : href.slice(0, at));
    anchor = at < 0 ? '' : decodeURIComponent(href.slice(at + 1));
  } catch { return null; }
  const resolved = target ? posixJoin(posixDirname(currentFile), target) : currentFile;
  if (!resolved || !/\.md$/i.test(resolved)) return null;
  const dir = posixDirname(resolved);
  const route = resolved === 'README.md' ? '#/' : /\/README\.md$/i.test(resolved)
    ? `#/plan/${encodeURIComponent(dir)}` : `#/file/${encodeURIComponent(resolved)}`;
  return route + (anchor ? `?anchor=${encodeURIComponent(anchor)}` : '');
}

export function parseRoute(hash) {
  const [pathname, query = ''] = (hash || '#/').split('?');
  const anchor = new URLSearchParams(query).get('anchor') || '';
  const match = pathname.match(/^#\/(plan|file)\/(.+)$/);
  if (match) {
    try { return { kind: match[1], path: decodeURIComponent(match[2]), anchor }; }
    catch { return { kind: 'invalid', path: '', anchor: '' }; }
  }
  return { kind: pathname === '#/' ? 'home' : 'invalid', path: '', anchor };
}

/** Every navigation invalidates both successful and failed older requests. */
export function createNavigation() {
  let version = 0;
  let controller;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const mine = ++version;
      return { signal: controller.signal, isCurrent: () => mine === version };
    },
  };
}

export async function loadCurrentFile(file, ticket, fetcher = fetch) {
  try {
    const res = await fetcher(`/api/file?p=${encodeURIComponent(file)}`, { signal: ticket.signal });
    const body = await res.json();
    if (!ticket.isCurrent()) return null;
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  } catch (err) {
    if (!ticket.isCurrent()) return null;
    throw err;
  }
}
