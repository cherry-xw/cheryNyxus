import { existsSync, copyFileSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

/**
 * pnpm install 后自动初始化开发环境种子：
 *   1) .env.example     → .env           （单文件,copyFileSync）
 *   2) .chery.template/ → .chery/        （目录递归,cpSync）
 *
 * 行为约定（与 Electron afterPack 钩子 [web/scripts/post-pack.mjs] 对齐）：
 *   - 目标已存在 → 跳过（保护用户已有编辑，pnpm install 不会覆盖）
 *   - 模板缺失 → 跳过 + 警告（不抛错,允许模板未就绪的仓库继续装依赖）
 *   - 拷贝失败 → 设 process.exitCode = 1,中断 postinstall 钩子
 */

const SEEDS = [
  { src: '.env.example',     dest: '.env' },           // 单文件
  { src: '.chery.template',  dest: '.chery', recursive: true }, // 目录
]

for (const { src, dest, recursive } of SEEDS) {
  const srcPath = resolve(root, src)
  const destPath = resolve(root, dest)
  if (existsSync(destPath)) {
    console.log(`${dest} already exists, skipped`)
    continue
  }
  if (!existsSync(srcPath)) {
    console.warn(`${src} not found, skipped`)
    continue
  }
  try {
    if (recursive) {
      cpSync(srcPath, destPath, { recursive: true })
    } else {
      copyFileSync(srcPath, destPath)
    }
    console.log(`✓ ${dest} created from ${src}`)
  } catch (err) {
    console.error(`✗ ${dest} copy failed: ${err?.message ?? err}`)
    process.exitCode = 1
  }
}
