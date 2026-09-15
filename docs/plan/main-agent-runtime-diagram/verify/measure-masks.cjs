// Measure board dimensions for key masks.
const fs = require('fs')
const path = require('path')
const ts = require('typescript')
const root = path.resolve(__dirname, '../../../..')
const src = path.join(root, 'web/src/features/agent/workbench/runtime-diagram')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const m = { exports: {} }
  cache.set(file, m)
  const code = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const wrapper = new Function('require', 'module', 'exports', js + '\n//# sourceURL=' + file)
  wrapper((name) => load(path.join(path.dirname(file), `${name}.ts`)), m, m.exports)
  return m.exports
}
const { buildNestedHeader } = load(path.join(src, 'headerNestedLayout.ts'))
const { HEADER_LAYERS } = load(path.join(src, 'headerTemplate.ts'))
const ids = HEADER_LAYERS.map((l) => l.id)
const { layerAncestors } = load(path.join(src, 'headerLayout.ts'))

function openedFor(layer) {
  return new Set(layerAncestors(layer).filter((id) => ids.includes(id)))
}

for (const mask of [16, 255]) {
  const opened = mask === 16 ? openedFor('model-layer') : new Set(ids)
  const graph = buildNestedHeader(opened)
  const boards = new Map()
  for (const item of graph.items) boards.set(item.id, item)
  console.log(`=== mask ${mask} opened=[${[...opened].join(',')}]`)
  console.log(`graph ${graph.width}x${graph.height}`)
  for (const id of ['loop', 'record', 'tools', 'collaboration', 'retry-layer'])
    if (boards.has(id))
      console.log(`  ${id}: ${boards.get(id).x},${boards.get(id).y} ${boards.get(id).width}x${boards.get(id).height}`)
  // tools-board edges bend counts
  for (const e of graph.edges.filter((e) => e.id.startsWith('tools:')))
    console.log(`  edge ${e.id}: bends=${e.points.length - 2} pts=${JSON.stringify(e.points)}`)
  for (const e of graph.edges.filter((e) => e.id.startsWith('collaboration:')))
    console.log(`  edge ${e.id}: bends=${e.points.length - 2} pts=${JSON.stringify(e.points)}`)
  for (const e of graph.edges.filter((e) => e.id.startsWith('retry-layer:')))
    console.log(`  edge ${e.id}: bends=${e.points.length - 2} pts=${JSON.stringify(e.points)}`)
  for (const e of graph.edges.filter((e) => e.id.startsWith('model-layer:')))
    console.log(`  edge ${e.id}: bends=${e.points.length - 2} pts=${JSON.stringify(e.points)}`)
}
