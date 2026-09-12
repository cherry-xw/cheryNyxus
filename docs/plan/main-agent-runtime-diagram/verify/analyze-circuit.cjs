// Source-only geometry audit: node docs/plan/main-agent-runtime-diagram/verify/analyze-circuit.cjs
// Uses the public TypeScript compiler API; never reads dependency implementations or UI images.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
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
const { WORKFLOW_HEADER_TEMPLATE: template, HEADER_LAYERS } = load(path.join(source, 'headerTemplate.ts'))
// Why context now lives beside request: the old intake package creates this K3,3 subdivision
// when collapsed. Verify the witness directly; no graph-library installation is required.
const oldIntake = new Set(['submission', 'queue', 'context', 'wake'])
const contracted = (id) => oldIntake.has(id) ? 'intake' : id
const oldEdges = new Set(template.edges.flatMap((e) => {
  const a = contracted(e.source), b = contracted(e.target)
  return [`${a}:${b}`, `${b}:${a}`]
}))
const obstruction = [
  ['input', 'entry', 'decision'], ['input', 'request'], ['input', 'parent-receive'],
  ['error', 'result', 'decision'], ['intake', 'wait', 'decision'],
  ['intake', 'request'], ['intake', 'parent-receive'],
  ['error', 'model', 'response', 'channels', 'tool-list', 'resume', 'tool-result', 'rejection',
    'execution', 'dispatch', 'child-run', 'child-return', 'parent-receive'],
  ['error', 'retry', 'request'],
]
const left = ['input', 'error', 'intake'], right = ['request', 'parent-receive', 'decision']
const internal = new Set(), pairs = new Set()
for (const route of obstruction) {
  assert(left.includes(route[0]) && right.includes(route.at(-1)))
  pairs.add(`${route[0]}:${route.at(-1)}`)
  for (let i = 1; i < route.length; i++) assert(oldEdges.has(`${route[i - 1]}:${route[i]}`))
  for (const id of route.slice(1, -1)) {
    assert(!left.includes(id) && !right.includes(id) && !internal.has(id))
    internal.add(id)
  }
}
assert.equal(pairs.size, 9)
// A rotation-system certificate for the unclustered semantic graph, not a pixel layout.
// At each vertex these neighbors are in cyclic order. Following oriented half-edges
// visits 17 faces; a connected orientable embedding with V-E+F=2 has genus zero.
const rotation = {
  entry: ['input', 'wake', 'queue', 'decision'], submission: ['queue'],
  queue: ['submission', 'entry'], context: ['request'],
  wake: ['wait', 'entry', 'parent-receive'],
  input: ['request', 'command', 'parent-receive', 'entry'], command: ['request', 'input'],
  checkpoint: ['tool-result', 'channels', 'decision'],
  request: ['input', 'retry', 'model', 'command', 'compact-request', 'context', 'compact-applied'],
  model: ['error', 'response', 'request'], response: ['model', 'channels'],
  channels: ['response', 'checkpoint', 'tool-list'], error: ['retry', 'result', 'model'],
  retry: ['error', 'request'], 'tool-list': ['channels', 'resume', 'validation'],
  validation: ['rejection', 'authorization', 'tool-list'],
  authorization: ['validation', 'rejection', 'approval-needed'],
  'approval-needed': ['approval', 'preflight', 'authorization'],
  approval: ['rejection', 'preflight', 'approval-needed'],
  preflight: ['rejection', 'execution', 'approval-needed', 'approval'],
  execution: ['tool-result', 'dispatch', 'preflight', 'rejection'],
  'tool-result': ['resume', 'checkpoint', 'execution', 'rejection'],
  rejection: ['authorization', 'validation', 'tool-result', 'execution', 'preflight', 'approval'],
  resume: ['tool-result', 'tool-list'], decision: ['entry', 'wait', 'checkpoint', 'result'],
  wait: ['wake', 'decision'], result: ['error', 'decision'],
  'compact-request': ['compact-summary', 'request'],
  'compact-summary': ['compact-request', 'compact-applied'],
  'compact-applied': ['compact-summary', 'request'], dispatch: ['child-run', 'execution'],
  'child-run': ['dispatch', 'child-return'], 'child-return': ['child-run', 'parent-receive'],
  'parent-receive': ['wake', 'input', 'child-return'],
}
assert.deepEqual(Object.keys(rotation).sort(), template.nodes.map((n) => n.id).sort())
for (const [id, neighbors] of Object.entries(rotation)) {
  const actual = template.edges.flatMap((e) => e.source === id ? [e.target] : e.target === id ? [e.source] : [])
  assert.deepEqual([...neighbors].sort(), actual.sort(), `Adjacency certificate: ${id}`)
}
const reachable = new Set(), pending = [template.nodes[0].id]
while (pending.length) {
  const node = pending.pop()
  if (reachable.has(node)) continue
  reachable.add(node)
  pending.push(...rotation[node])
}
assert.equal(reachable.size, template.nodes.length)
const visited = new Set(), faces = []
for (const [a, neighbors] of Object.entries(rotation)) for (const b of neighbors) {
  if (visited.has(`${a}:${b}`)) continue
  let x = a, y = b
  const face = []
  do {
    assert(!visited.has(`${x}:${y}`))
    visited.add(`${x}:${y}`)
    face.push([x, y])
    const neighbors = rotation[y]
    ;[x, y] = [y, neighbors[(neighbors.indexOf(x) + 1) % neighbors.length]]
  } while (x !== a || y !== b)
  faces.push(face)
}
assert.equal(visited.size, template.edges.length * 2)
assert.equal(template.nodes.length - template.edges.length + faces.length, 2)
const { layoutHeader } = load(path.join(source, 'headerLayout.ts'))
const started = performance.now()
const graph = layoutHeader(HEADER_LAYERS.map((layer) => layer.id))
const elapsedMs = Math.round(performance.now() - started)
const segments = graph.edges.flatMap((edge) => edge.points.slice(1).map((b, i) => ({
  edge: edge.id, board: edge.id.split(':')[0], a: edge.points[i], b,
})))
const crossings = []
for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
  const s = segments[i], t = segments[j]
  if (s.edge === t.edge || (s.a.y === s.b.y) === (t.a.y === t.b.y)) continue
  const [h, v] = s.a.y === s.b.y ? [s, t] : [t, s]
  if (v.a.x > Math.min(h.a.x, h.b.x) && v.a.x < Math.max(h.a.x, h.b.x) &&
      h.a.y > Math.min(v.a.y, v.b.y) && h.a.y < Math.max(v.a.y, v.b.y)) {
    crossings.push({ first: s.edge, second: t.edge, x: v.a.x, y: h.a.y })
  }
}
const routes = graph.edges.map((edge) => {
  const length = edge.points.slice(1).reduce((sum, p, i) => sum +
    Math.abs(p.x - edge.points[i].x) + Math.abs(p.y - edge.points[i].y), 0)
  const first = edge.points[0], last = edge.points.at(-1)
  const direct = Math.abs(first.x - last.x) + Math.abs(first.y - last.y)
  return { id: edge.id, bends: edge.points.length - 2, length, direct,
    detour: Math.round(length / Math.max(1, direct) * 100) / 100, points: edge.points }
})
const byBoard = {}
for (const board of ['overview', ...HEADER_LAYERS.map((l) => l.id)]) {
  const edges = routes.filter((r) => r.id.startsWith(`${board}:`))
  byBoard[board] = { edges: edges.length,
    crossings: crossings.filter((c) => c.first.startsWith(`${board}:`) && c.second.startsWith(`${board}:`)).length,
    maxBends: Math.max(0, ...edges.map((e) => e.bends)),
    totalLength: edges.reduce((sum, e) => sum + e.length, 0) }
}
const result = { template, planarity: { vertices: template.nodes.length, edges: template.edges.length,
  faces: faces.length, euler: 2, scope: 'Unclustered topology; all nested geometry is checked by workflowHeaderLayout tests', rotation,
  oldIntakeObstruction: { kind: 'K3,3 subdivision', left, right, paths: obstruction } },
  geometry: { width: graph.width, height: graph.height, elapsedMs,
  stepCount: graph.items.filter((n) => n.kind === 'step').length,
  edgeSegments: graph.edges.length, crossings: crossings.length, byBoard },
  items: graph.items, routes, crossings }
fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true })
fs.writeFileSync(path.join(__dirname, 'out/circuit-analysis.json'), JSON.stringify(result, null, 2))
const title = (id) => template.nodes.find((n) => n.id === id).title
const layerTitle = (id) => HEADER_LAYERS.find((l) => l.id === id)?.title ?? '总览'
const report = [
  '# 全部展开的节点与连线分析', '',
  '由当前项目源码计算生成；未启动界面或进行视觉验收。重跑：`node docs/plan/main-agent-runtime-diagram/verify/analyze-circuit.cjs`。', '',
  `34 个步骤，49 条原始关系，90 条跨层绘制路径，${crossings.length} 处严格线段内部交叉。交叉统计不包含端点接触、同向重叠或曲线桥形状，因而不是全部冲突数量。`, '',
  '原始拓扑存在平面嵌入证书：34 个顶点、49 条无向边、17 个面，34 − 49 + 17 = 2。忽略箭头只用于平面性判断，不删除业务方向。此证书不保证固定矩形嵌套、固定端口或当前节点尺寸下可直接布线。', '',
  '## 分层统计', '', '| 层 | 绘制路径 | 内部交叉 | 最多转弯 | 总线长（画布单位） |', '| --- | ---: | ---: | ---: | ---: |',
  ...Object.entries(byBoard).map(([id, m]) => `| ${layerTitle(id)} | ${m.edges} | ${m.crossings} | ${m.maxBends} | ${m.totalLength} |`), '',
  '## 节点归属', '', '| 层 | 节点（名称 / ID） |', '| --- | --- |',
  ...HEADER_LAYERS.map((l) => `| ${l.title} | ${template.nodes.filter((n) => n.group === l.id).map((n) => `${n.title} / ${n.id}`).join('；')} |`), '',
  '## 全部 49 条原始连接', '', '| 编号 | 来源 | 目标 | 条件或含义 | 类型 |', '| --- | --- | --- | --- | --- |',
  ...template.edges.map((e, i) => `| ${i + 1} | ${title(e.source)} | ${title(e.target)} | ${e.label ?? '直接连接'} | ${e.role} |`), '',
  '## 完整逻辑图', '', '下面是关系图，Mermaid 自动排版不作为无交叉坐标方案或视觉验收。', '', '```mermaid', 'flowchart TB',
  ...template.nodes.map((n, i) => `  n${i}["${n.title}"]`),
  ...template.edges.map((e) => `  n${template.nodes.findIndex((n) => n.id === e.source)} -->${e.label ? `|"${e.label}"|` : ''} n${template.nodes.findIndex((n) => n.id === e.target)}`),
  '```', '', '## 转弯最多的路径', '', '| 跨层路径 ID | 转弯数 | 路径长度 | 端点曼哈顿距离 |', '| --- | ---: | ---: | ---: |',
  ...[...routes].sort((a, b) => b.bends - a.bends).slice(0, 12).map((r) => `| ${r.id} | ${r.bends} | ${r.length} | ${r.direct} |`), '',
  '完整坐标与交叉对保存在同目录 circuit-analysis.json。端点曼哈顿距离只是不考虑障碍与端口方向的下界，不代表该长度一定可实现。', '',
]
fs.writeFileSync(path.join(__dirname, 'out/circuit-analysis.md'), report.join('\n'))
console.log(JSON.stringify({ geometry: result.geometry, planarity: { vertices: 34, edges: 49, faces: faces.length, euler: 2 } }, null, 2))
