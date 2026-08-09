#!/usr/bin/env node
/**
 * 死代码交叉扫描：knip（unused exports/types/deps）∩ CodeGraph（零引用符号图）。
 *
 * 三组输出：
 *   GROUP 1  knip ∩ codegraph 零引用      -> 高置信死代码（删前仍需 grep test/+web/ 二次确认）
 *   GROUP 2  codegraph 零引用但 knip 未报 -> 多为 CodeGraph 误标局部变量；真模块级项需人工甄别
 *   GROUP 3  knip 报但 codegraph 有引用    -> 动态注册/分发误报，排除
 *
 * 依赖：root 已装 knip；.codegraph/ 已索引。仅扫 src/（root 后端），不含 web/test。
 *
 * 用法：pnpm deadcode:scan
 */
import Database from 'better-sqlite3'
import { execSync } from 'node:child_process'

const REF_KINDS = ['calls', 'references', 'imports', 'instantiates', 'extends', 'implements']
const USE_KINDS = ['calls', 'references', 'instantiates', 'extends', 'implements']

const db = new Database('.codegraph/codegraph.db', { readonly: true })

// 1. 跑 knip json reporter（knip 发现问题会 exit 1，属正常，json 在 stdout）
let knipJson
try {
  knipJson = execSync('npx knip --no-progress --reporter json', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
} catch (e) {
  knipJson = e.stdout
  if (!knipJson) throw e
}
const knip = JSON.parse(knipJson)

// 2. 收集 knip unused exports + types
const knipMap = new Map()
for (const issue of knip.issues) {
  for (const e of issue.exports || []) knipMap.set(`${issue.file}:${e.name}`, { file: issue.file, name: e.name, line: e.line, cat: 'export' })
  for (const t of issue.types || []) knipMap.set(`${issue.file}:${t.name}`, { file: issue.file, name: t.name, line: t.line, cat: 'type' })
}

// 3. codegraph: 模块级（被 file contains，非被 function/method/class contains）零引用 export
const zero = db
  .prepare(
    `SELECT n.file_path, n.kind, n.name, n.start_line
     FROM nodes n
     WHERE n.is_exported = 1
       AND n.file_path LIKE 'src/%'
       AND n.file_path NOT IN ('src/index.ts','src/worker.ts')
       AND EXISTS (SELECT 1 FROM edges e JOIN nodes s ON e.source=s.id WHERE e.target=n.id AND e.kind='contains' AND s.kind='file')
       AND NOT EXISTS (SELECT 1 FROM edges e JOIN nodes s ON e.source=s.id WHERE e.target=n.id AND e.kind='contains' AND s.kind IN ('function','method','class'))
       AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.target=n.id AND e.kind IN (${REF_KINDS.map(() => '?').join(',')}))`,
  )
  .all(...REF_KINDS)
const cgZeroMap = new Map()
for (const z of zero) cgZeroMap.set(`${z.file_path}:${z.name}`, z)

// 4. 三组
const group1 = []
const group2 = []
for (const [key, z] of cgZeroMap) {
  if (knipMap.has(key)) group1.push({ ...z, knip: knipMap.get(key) })
  else group2.push(z)
}
const group3 = []
for (const [key, k] of knipMap) if (!cgZeroMap.has(key)) group3.push(k)

const fmt = (z) => `${z.file_path || z.file}:${z.start_line || z.line}  ${z.kind || z.cat}  ${z.name}`

console.log(`=== GROUP 1: 高置信死代码 (knip ∩ codegraph 零引用): ${group1.length} ===`)
console.log('    删前仍需 grep test/ + web/ 二次确认（动态调用/注释提及）')
for (const z of group1.sort((a, b) => (a.file_path || '').localeCompare(b.file_path || ''))) console.log('  ' + fmt(z))

console.log(`\n=== GROUP 2: codegraph-only 零引用 (knip 未报; 多为局部变量噪声，模块级项需人工): ${group2.length} ===`)
const g2Mod = group2.filter((z) => !['constant', 'variable'].includes(z.kind))
for (const z of g2Mod.sort((a, b) => a.file_path.localeCompare(b.file_path))) console.log('  ' + fmt(z))
console.log(`  (另有 ${group2.length - g2Mod.length} 个 constant/variable 多为函数内局部，噪声)`)

console.log(`\n=== GROUP 3: knip 报但 codegraph 有引用 (动态注册误报，排除): ${group3.length} ===`)
const byFile = new Map()
for (const k of group3) {
  if (!byFile.has(k.file)) byFile.set(k.file, [])
  byFile.get(k.file).push(k.name)
}
let shown = 0
for (const [f, names] of [...byFile.entries()].sort()) {
  if (shown >= 15) {
    console.log(`  ... 其余 ${byFile.size - 15} 文件`)
    break
  }
  console.log(`  ${f}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` (+${names.length - 6})` : ''}`)
  shown++
}

console.log('\n=== knip 依赖级 ===')
for (const issue of knip.issues) {
  for (const d of issue.dependencies || []) console.log(`  unused dep: ${d.name}`)
  for (const d of issue.devDependencies || []) console.log(`  unused devDep: ${d.name}`)
  for (const d of issue.duplicates || []) console.log(`  duplicate export: ${issue.file}: ${d.name}`)
}

db.close()
