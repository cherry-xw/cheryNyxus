#!/usr/bin/env node
/**
 * CheryNyxus Electron 一键打包脚本
 *
 * Electron 纯前端壳打包流程：前端构建 → electron-builder 打包。
 *
 * 用法：
 *   node scripts/pack-electron.mjs                       # 一键全量打包（默认）
 *   node scripts/pack-electron.mjs --skip-deps           # 跳过依赖安装（日常增量构建）
 *   node scripts/pack-electron.mjs --skip-check           # 跳过类型检查
 *   node scripts/pack-electron.mjs --only-build          # 保留兼容参数，执行同一纯前端流程
 *   DEBUG=1 node scripts/pack-electron.mjs       # 显示详细调试信息
 *
 * 环境变量（可覆盖 package.json 的 packConfig）：
 *   ELECTRON_PACK_PROXY          代理
 *   ELECTRON_MIRROR               Electron 下载镜像
 *   ELECTRON_BUILDER_BINARIES_MIRROR  辅助二进制镜像
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePackConfig, applyProxyEnv } from './pack-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const webRoot = join(repoRoot, 'web')

// ===== 解析命令行参数 =====
const args = process.argv.slice(2)
const flags = { onlyBuild: args.includes('--only-build') }

// ===== 代理 & 镜像配置（来自 package.json packConfig，env 可覆盖） =====
const packConfig = resolvePackConfig()
applyProxyEnv(packConfig)
const HTTP_PROXY = packConfig.httpProxy

// ===== 工具函数 =====
const DEBUG = !!process.env.DEBUG

function log(step, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${ts}] [pack] [${step}] ${msg}`)
}

function debug(step, msg) {
  if (DEBUG) log(step, msg)
}

/** 同步运行命令，失败抛错并终止 */
function run(cmd, cmdArgs, opts = {}) {
  log('exec', `${cmd} ${cmdArgs.join(' ')}`)
  debug('exec', `cwd: ${opts.cwd ?? repoRoot}`)
  // Windows 下 pnpm/npm 等是 .cmd shim，不带 shell: true 时 spawnSync 找不到
  const useShell = opts.shell ?? process.platform === 'win32'
  const result = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: opts.cwd ?? repoRoot,
    shell: useShell,
    env: { ...process.env, ...opts.env },
  })
  if (result.status !== 0) {
    const errMsg = `命令失败 (exit ${result.status ?? 'unknown'}): ${cmd} ${cmdArgs.join(' ')}`
    console.error(`\n❌ [pack] ${errMsg}\n`)
    process.exit(1)
  }
  return result
}

/** 分隔线 */
function banner(title) {
  console.log('\n' + '═'.repeat(60))
  console.log(`  ${title}`)
  console.log('═'.repeat(60))
}

/** 计时器 */
function timer() {
  const start = Date.now()
  return {
    elapsed() {
      const ms = Date.now() - start
      if (ms < 1000) return `${ms}ms`
      return `${(ms / 1000).toFixed(1)}s`
    },
  }
}

// ===== 步骤实现 =====

function stepBuildFrontend() {
  banner('Step 1/2: 前端与 Electron 主进程/preload 构建')
  run('pnpm', ['--filter', 'web', 'build'])
  log('build', '✓ 前端构建完成')
}

function stepElectronBuilderPack() {
  banner('Step 2/2: electron-builder 打包安装包')

  const distScript = join(webRoot, 'scripts', 'dist-electron.mjs')
  run('node', [distScript], { cwd: webRoot })

  log('pack', '✓ 纯前端 Electron 安装包生成完成')
}

// ===== 主流程 =====
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║          CheryNyxus Electron 一键打包                    ║')
  console.log('╚══════════════════════════════════════════════════════════╝')
  console.log(`  平台: ${process.platform}-${process.arch}`)
  console.log(`  Node: ${process.version}`)
  console.log(`  代理: ${HTTP_PROXY}`)
  console.log(`  Electron 镜像: ${process.env.ELECTRON_MIRROR}`)
  console.log(`  兼容参数 only-build: ${flags.onlyBuild}`)

  const totalTimer = timer()

  try {
    // Electron 是前端壳；后端和其他运行时文件由独立发布物提供。
    stepBuildFrontend()
    stepElectronBuilderPack()

    // 完成
    banner('✓ 打包完成')
    console.log(`  总耗时: ${totalTimer.elapsed()}`)
    console.log(`  产物目录: ${join(webRoot, 'release')}`)
    console.log('')
  } catch (err) {
    console.error(`\n❌ 打包失败: ${err.message}`)
    if (DEBUG) console.error(err.stack)
    process.exit(1)
  }
}

main()
