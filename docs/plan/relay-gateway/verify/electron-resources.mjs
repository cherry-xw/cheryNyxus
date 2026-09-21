#!/usr/bin/env node
/**
 * relay-gateway H：检查 Electron 当前源文件和打包配置没有重新引入后端运行时。
 * 用法：node docs/plan/relay-gateway/verify/electron-resources.mjs
 */
import { readFileSync } from 'node:fs'

const files = [
  'web/electron/main.ts',
  'web/electron/preload.ts',
  'web/electron-builder.yml',
  'web/scripts/dist-electron.mjs',
  'scripts/pack-electron.mjs',
]
const forbidden = [
  /spawn\([^)]*(?:dist\/index|backend|worker)/i,
  /extraResources/i,
  /build[\\/]node/i,
  /terminal-runtime/i,
  /\.chery(?:[\\/'"]|\s|$)/i,
]

const failures = []
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  for (const pattern of forbidden) {
    if (pattern.test(source)) failures.push(`${file}: ${pattern}`)
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`Electron 纯前端资源扫描通过：${files.length} 个源文件未发现后端运行时入口`)
