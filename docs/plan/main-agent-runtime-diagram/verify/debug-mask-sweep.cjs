// Throwaway: sweep all 256 expansion masks, catch routing/label failures, report board + geometry.
// Usage: node docs/plan/main-agent-runtime-diagram/verify/debug-mask-sweep.cjs
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
const routing = load(path.join(source, 'headerBoardRouting.ts'))
const original = routing.routeBoardEdges
let context = null
routing.routeBoardEdges = (items, relations, ports, options) => {
  try {
    return original(items, relations, ports, options)
  } catch (error) {
    context = {
      message: error.message,
      items: items.map((i) => ({ id: i.id, x: i.x, y: i.y, width: i.width, height: i.height, kind: i.kind })),
      relations: relations.map((r) => ({ id: r.id, source: r.source, target: r.target, label: r.label })),
      ports,
      size: options,
      routed: null,
    }
    throw error
  }
}
const nested = load(path.join(source, 'headerNestedLayout.ts'))
const { HEADER_LAYERS } = load(path.join(source, 'headerTemplate.ts'))
const ids = HEADER_LAYERS.map((l) => l.id)
const failures = []
for (let mask = 0; mask < 256; mask++) {
  const opened = new Set(ids.filter((_, i) => mask & (1 << i)))
  context = null
  try {
    nested.buildNestedHeader(opened)
  } catch (error) {
    failures.push({ mask, opened: [...opened], error: error.message, context })
  }
}
console.log(`failures: ${failures.length}/256`)
for (const f of failures.slice(0, 40)) {
  console.log(`\n=== mask ${f.mask} opened=[${f.opened.join(',')}] : ${f.error}`)
  if (f.context) {
    console.log(`board ${f.context.size.width}x${f.context.size.height}`)
    console.log('items:', f.context.items.map((i) => `${i.id}(${i.x},${i.y} ${i.width}x${i.height})`).join(' '))
    console.log('ports:', JSON.stringify(f.context.ports))
    const labeled = f.context.relations.filter((r) => r.label)
    console.log('labeled relations:', labeled.map((r) => `${r.id}[${r.label}] ${r.source}->${r.target}`).join('; '))
  }
}
fs.writeFileSync(path.join(__dirname, 'out/debug-masks.json'), JSON.stringify(failures, null, 2))
