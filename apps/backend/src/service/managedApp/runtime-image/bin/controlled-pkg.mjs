#!/usr/bin/env node
/**
 * 受控包管理拦截器 (npm / npx / pnpm / yarn)
 *
 * 1. 允许离线执行标准项目脚本:
 *    - npm run build / npm run start / npm run db:migrate / npm test
 *    - npm start / npm build
 * 2. 当模型或脚本调用 install / i / add / ci / dlx / exec 安装包时:
 *    - 读取 /opt/chery-app-template/package.json 的内置固定依赖表
 *    - 若未指定外部包且 /workspace/package.json 所有依赖均在内置白名单中，则自动确保 /workspace/node_modules -> /opt/chery-app-template/node_modules 软链就绪并返回 0
 *    - 若请求了任何不在固定模板内的包，立即拒绝并输出结构化错误 DEPENDENCY_NOT_IN_TEMPLATE，绝不联网拉包
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const TEMPLATE_ROOT = '/opt/chery-app-template'
const TEMPLATE_PKG_PATH = path.join(TEMPLATE_ROOT, 'package.json')
const WORKSPACE_ROOT = process.cwd()

function loadAllowedPackages() {
  const raw = JSON.parse(fs.readFileSync(TEMPLATE_PKG_PATH, 'utf8'))
  return new Set([
    ...Object.keys(raw.dependencies ?? {}),
    ...Object.keys(raw.devDependencies ?? {}),
  ])
}

function ensureNodeModulesSymlink() {
  const target = path.join(TEMPLATE_ROOT, 'node_modules')
  const linkPath = path.join(WORKSPACE_ROOT, 'node_modules')
  try {
    const st = fs.lstatSync(linkPath)
    if (st.isSymbolicLink()) return
  } catch {
    // link does not exist
  }
  try {
    fs.symlinkSync(target, linkPath, 'dir')
  } catch {
    // ignore if read-only or already exists
  }
}

function failDependencyNotInTemplate(badPackages, allowedSet) {
  const allowedList = Array.from(allowedSet).sort().join(', ')
  console.error(
    JSON.stringify({
      error: {
        code: 'DEPENDENCY_NOT_IN_TEMPLATE',
        rejectedPackages: badPackages,
        message: `受管工作容器采用离线固定模板，禁止安装模板外的 npm 包 (${badPackages.join(', ')})。请直接使用内置依赖: ${allowedList} 或 Node 24 标准库 (如 node:sqlite, node:crypto)。`,
        builtInPackages: Array.from(allowedSet).sort(),
      },
    }),
  )
  process.exit(1)
}

function normalizePkgSpec(spec) {
  if (!spec || spec.startsWith('-')) return null
  if (spec.startsWith('@')) {
    const parts = spec.slice(1).split('@')
    return '@' + parts[0]
  }
  return spec.split('@')[0]
}

const invokedAs = path.basename(process.argv[1] || 'npm')
const args = process.argv.slice(2)
const allowedSet = loadAllowedPackages()

if (invokedAs === 'npx' || invokedAs === 'pnpx') {
  const cmd = args.find(a => !a.startsWith('-'))
  if (cmd === 'vite') {
    ensureNodeModulesSymlink()
    const rest = args.slice(args.indexOf(cmd) + 1)
    const hasLoader = rest.includes('--configLoader')
    const finalArgs = hasLoader ? rest : [...rest, '--configLoader', 'native']
    const r = spawnSync(
      process.execPath,
      [path.join(TEMPLATE_ROOT, 'node_modules/vite/bin/vite.js'), ...finalArgs],
      { stdio: 'inherit', env: { ...process.env, NODE_PATH: path.join(TEMPLATE_ROOT, 'node_modules') } },
    )
    process.exit(r.status ?? 1)
  }
  failDependencyNotInTemplate([cmd || 'unknown'], allowedSet)
}

const sub = args[0] || ''

if (sub === 'run' || sub === 'run-script') {
  const scriptName = args[1]
  ensureNodeModulesSymlink()
  const pkgPath = path.join(WORKSPACE_ROOT, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    console.error('package.json not found in current directory')
    process.exit(1)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (scriptName === 'build') {
    let scanned = 0
    const visit = directory => {
      if (!fs.existsSync(directory)) return
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++scanned > 20000) throw new Error('Build source scan exceeds file limit')
        const file = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { if (!['node_modules', '.git', 'dist'].includes(entry.name)) visit(file); continue }
        if (!/\.(?:vue|js|ts|jsx|tsx)$/.test(entry.name)) continue
        if (fs.statSync(file).size > 1024 * 1024) throw new Error('Build source file exceeds scan limit')
        const source = fs.readFileSync(file, 'utf8')
        if (/\bfetch\s*\(\s*['"`]\/api(?:\/|['"`])/.test(source)) throw new Error('APP_BASE_REQUIRED: 请使用 apiFetch 或应用前缀，不能硬编码 fetch("/api/...")')
      }
    }
    visit(path.join(WORKSPACE_ROOT, 'src'))
  }
  const allRequested = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]
  const unsupported = allRequested.filter(name => !allowedSet.has(name))
  if (unsupported.length > 0) {
    failDependencyNotInTemplate(unsupported, allowedSet)
  }

  let scriptCmd = pkg.scripts?.[scriptName]
  if (!scriptCmd) {
    console.error(`Missing script: "${scriptName}"`)
    process.exit(1)
  }
  if (
    scriptCmd.includes('vite build') &&
    !scriptCmd.includes('--configLoader')
  ) {
    scriptCmd = scriptCmd.replace(
      'vite build',
      'vite build --configLoader native',
    )
  }
  const r = spawnSync('sh', ['-c', scriptCmd], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_PATH: path.join(TEMPLATE_ROOT, 'node_modules'),
      PATH: `${path.join(TEMPLATE_ROOT, 'node_modules/.bin')}:${process.env.PATH || ''}`,
    },
  })
  process.exit(r.status ?? 1)
}

if (sub === 'start') {
  const r = spawnSync(process.execPath, [process.argv[1], 'run', 'start'], {
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}

if (sub === 'build') {
  const r = spawnSync(process.execPath, [process.argv[1], 'run', 'build'], {
    stdio: 'inherit',
  })
  process.exit(r.status ?? 1)
}

if (['install', 'i', 'add', 'ci', 'dlx', 'exec', 'update', 'up'].includes(sub)) {
  const explicitSpecs = args
    .slice(1)
    .map(normalizePkgSpec)
    .filter(Boolean)

  const badExplicit = explicitSpecs.filter(name => !allowedSet.has(name))
  if (badExplicit.length > 0) {
    failDependencyNotInTemplate(badExplicit, allowedSet)
  }

  const pkgPath = path.join(WORKSPACE_ROOT, 'package.json')
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const allRequested = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]
    const unsupported = allRequested.filter(name => !allowedSet.has(name))
    if (unsupported.length > 0) {
      failDependencyNotInTemplate(unsupported, allowedSet)
    }
  }

  ensureNodeModulesSymlink()
  console.log(
    '[chery-template] 离线固定模板依赖已就绪 (/opt/chery-app-template/node_modules)，无需联网下载。',
  )
  process.exit(0)
}

if (sub === '-v' || sub === '--version') {
  console.log('chery-controlled-npm/1.0.0')
  process.exit(0)
}

failDependencyNotInTemplate([sub || 'unknown-command'], allowedSet)
