// Throwaway: find ports whose |offset| exceeds the side bound across all 256 masks.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../../../..')
const source = path.join(root, 'web/src/features/agent/workbench/runtime-diagram')
const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }
  cache.set(file, module)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(
    (name) => {
      if (!name.startsWith('./')) throw new Error(`Unexpected runtime dependency: ${name}`)
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    }, module, module.exports,
  )
  return module.exports
}
const nested = load(path.join(source, 'headerNestedLayout.ts'))
const { HEADER_LAYERS } = load(path.join(source, 'headerTemplate.ts'))
const ids = HEADER_LAYERS.map((l) => l.id)
const bad = []
for (let mask = 0; mask < 256; mask++) {
  const opened = new Set(ids.filter((_, i) => mask & (1 << i)))
  const graph = nested.buildNestedHeader(opened)
  for (const edge of graph.edges) {
    for (const end of ['source', 'target']) {
      const item = graph.items.find((n) => n.id === edge[end])
      if (!item) continue
      const port = graph.ports[item.id]?.find((p) => p.id === edge[`${end}Handle`])
      if (!port) continue
      const bound = port.side === 'left' || port.side === 'right' ? item.height : item.width
      if (Math.abs(port.offset) > bound / 2)
        bad.push({
          mask: [...opened].join(','),
          edge: edge.id,
          end,
          item: item.id,
          side: port.side,
          offset: port.offset,
          bound: bound / 2,
          itemSize: `${item.width}x${item.height}`,
        })
    }
  }
}
console.log(JSON.stringify(bad, null, 1))
console.log(`violations: ${bad.length}`)
