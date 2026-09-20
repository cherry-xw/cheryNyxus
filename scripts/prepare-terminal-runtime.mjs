import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, 'build', 'terminal-runtime')
const nodeFlag = process.argv.indexOf('--node')
const runtimeNode =
  nodeFlag >= 0
    ? resolve(process.argv[nodeFlag + 1])
    : join(root, 'build', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
if (!existsSync(runtimeNode))
  throw new Error('请先准备随安装包分发的 Node：node scripts/electron-pack.mjs node')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error || result.status !== 0)
    throw new Error(result.stderr || result.error?.message || `${command} 执行失败`)
  return result.stdout
}

// Query package-manager metadata; do not inspect or rewrite dependency source.
const installed = JSON.parse(
  run('pnpm', ['list', 'ssh2', 'node-pty', '--json', '--depth', '0'], {
    shell: process.platform === 'win32',
  }),
)
const dependencies = installed.find((pkg) => resolve(pkg.path) === root)?.dependencies
const versions = Object.fromEntries(
  ['ssh2', 'node-pty'].map((name) => {
    const version = dependencies?.[name]?.version
    if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version))
      throw new Error(`请先 pnpm install：缺少 ${name}`)
    return [name, version]
  }),
)
mkdirSync(runtime, { recursive: true })
const manifest =
  JSON.stringify(
    { name: 'chery-terminal-runtime', private: true, version: '1.0.0', dependencies: versions },
    null,
    2,
  ) + '\n'
const manifestPath = join(runtime, 'package.json')
if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifest)
  writeFileSync(manifestPath, manifest)
const env = { ...process.env }
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
env[pathKey] = dirname(runtimeNode) + delimiter + (env[pathKey] ?? '')
const npmOptions = { cwd: runtime, env, shell: process.platform === 'win32', stdio: 'inherit' }
// ssh2's native accelerators are optional; node-pty must prepare its native PTY.
run(
  'npm',
  ['install', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
  npmOptions,
)
run('npm', ['rebuild', 'node-pty'], npmOptions)
run(
  runtimeNode,
  [
    '-e',
    "if(typeof require('ssh2').Client!=='function'||typeof require('node-pty').spawn!=='function')process.exit(1)",
  ],
  { cwd: runtime, stdio: 'inherit' },
)
console.log('Terminal 运行依赖已准备并通过 Node 加载检查：' + runtime)
