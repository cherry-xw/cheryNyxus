// Read-only check of new documentation and added Markdown references.
// Run: node docs/plan/main-agent-runtime-diagram/verify/check-doc-links.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const tracked = git('diff', '--name-only', '--diff-filter=AM', '--', '*.md').trim().split('\n')
const added = git('ls-files', '--others', '--exclude-standard').trim().split('\n').filter(path => path.endsWith('.md'))
const failures = []
let checked = 0
function anchors(content) {
  const seen = new Map()
  return new Set([...content.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => {
    const slug = heading.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-')
    const count = seen.get(slug) ?? 0; seen.set(slug, count + 1)
    return count ? `${slug}-${count}` : slug
  }))
}
for (const path of new Set([...tracked, ...added].filter(Boolean))) {
  if (!existsSync(path)) continue
  const content = added.includes(path) ? readFileSync(path, 'utf8') : git('diff', '--unified=0', '--', path).split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n')
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].replace(/^<|>$/g, '')
    if (/^(?:https?:|mailto:|data:)/.test(href)) continue
    const [relative, fragment] = href.split('#')
    const target = relative ? resolve(dirname(path), decodeURIComponent(relative)) : resolve(path)
    checked++
    if (!existsSync(target)) { failures.push(`${path}: missing ${href}`); continue }
    if (fragment && statSync(target).isFile() && target.endsWith('.md')) {
      if (!anchors(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))) failures.push(`${path}: missing anchor ${href}`)
    }
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1 }
else console.log(`Passed: ${checked} new/changed documentation links and anchors`)
