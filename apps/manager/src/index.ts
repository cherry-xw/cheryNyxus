import { CredentialStore } from './credentials.js'
import { networkInterfaces } from 'node:os'
import { createManager, isLoopbackHost, readManagerHostFromConfig } from './server.js'
import { runManagerCli } from './cli.js'
import { readAuthOptions } from './authConfig.js'
import { readManagerPlugins, readConnectionCredentials } from './pluginConfig.js'

export * from './processController.js'
export * from './backendSupervisor.js'
export * from './backendPluginConfig.js'
export * from './server.js'
export * from './credentials.js'

async function startManager(): Promise<void> {
  // 监听地址优先级：CHERY_MANAGER_HOST 环境变量 > config.yaml 的 manager.host > 局域网。
  const cheryDir = process.env.CHERY_DIR ?? process.cwd()
  const configFile = `${cheryDir}/.chery/config.yaml`
  await new CredentialStore({
    configFile,
    credentialsFile: `${cheryDir}/.chery/manager-credentials.json`,
  }).ensureInternal()
  const configuredHost = await readManagerHostFromConfig(configFile)
  const host = process.env.CHERY_MANAGER_HOST || configuredHost || '0.0.0.0'
  const portOption =
    process.env.CHERY_MANAGER_PORT === undefined ? 39980 : Number(process.env.CHERY_MANAGER_PORT)
  if (!Number.isInteger(portOption) || portOption < 0 || portOption > 65535)
    throw new Error('CHERY_MANAGER_PORT 无效')
  const manager = createManager({
    backendMode: readBackendMode(process.env.CHERY_MANAGER_BACKEND_MODE),
    host,
    port: portOption,
    configFile,
    connectionCredentials: await readConnectionCredentials(configFile),
    auth: await readAuthOptions(configFile),
    plugins: await readManagerPlugins(configFile),
    controlToken: process.env.CHERY_MANAGER_TOKEN,
    relayStatusFile: process.env.CHERY_RELAY_STATUS_FILE,
    backendStatusFile: process.env.CHERY_BACKEND_STATUS_FILE,
  })
  await manager.listen()
  const port = manager.address()?.port ?? 39980
  // 地址不携带任何认证材料。
  const printHost = isAnyHost(host) ? (detectLanIpv4() ?? host) : host
  if (!isLoopbackHost(host)) {
    process.stdout.write('局域网访问已开启：请配置可信访问地址；远程部署使用 HTTPS。\n')
  }
  process.stdout.write(
    JSON.stringify({
      event: 'manager_listening',
      host,
      port,
      url: `http://${printHost.includes(':') ? `[${printHost}]` : printHost}:${port}/`,
    }) + '\n',
  )
  process.once('SIGINT', () => void manager.close().then(() => process.exit(0)))
  process.once('SIGTERM', () => void manager.close().then(() => process.exit(0)))
  // 只有持久化开关为 true 且非外部托管模式时，才由 Manager 自动拉起 Backend；运行状态变化不写回该开关。
  const autoStart = await manager.autoStartBackend()
  process.stdout.write(JSON.stringify({ event: 'manager_backend_autostart', ...autoStart }) + '\n')
}

function readBackendMode(value: string | undefined): 'child' | 'external' {
  if (value === undefined || value === 'child') return 'child'
  if (value === 'external') return 'external'
  throw new Error('CHERY_MANAGER_BACKEND_MODE 无效')
}

function isAnyHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '::ffff:0.0.0.0'
}

/** 最佳努力探测本机第一个非内部 IPv4 地址，用于打印内网可点击地址。 */
function detectLanIpv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return undefined
}

void runManagerCli(process.argv.slice(2))
  .then((handled) => {
    if (!handled) return startManager()
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
