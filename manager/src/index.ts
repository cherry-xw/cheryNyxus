import { networkInterfaces } from 'node:os'
import { createManager } from './server.js'
import { runManagerCli } from './cli.js'

export * from './processController.js'
export * from './server.js'
export * from './credentials.js'

async function startManager(): Promise<void> {
  // CHERY_MANAGER_HOST：默认仅本机回环；设置 0.0.0.0 或具体内网 IP 开放内网访问。
  const host = process.env.CHERY_MANAGER_HOST || '127.0.0.1'
  const manager = createManager({
    host,
    controlToken: process.env.CHERY_MANAGER_TOKEN,
    relayStatusFile: process.env.CHERY_RELAY_STATUS_FILE,
    backendStatusFile: process.env.CHERY_BACKEND_STATUS_FILE,
  })
  await manager.listen()
  const port = manager.address()?.port ?? 39980
  // 打印带管理密钥的可点击地址：绑定 0.0.0.0 时探测本机内网 IPv4，供内网设备直接打开。
  const printHost = isAnyHost(host) ? detectLanIpv4() ?? host : host
  process.stdout.write(
    JSON.stringify({
      event: 'manager_listening',
      host,
      port,
      url: `http://${printHost}:${port}/?token=${manager.token}`,
    }) + '\n',
  )
  process.once('SIGINT', () => void manager.close().then(() => process.exit(0)))
  process.once('SIGTERM', () => void manager.close().then(() => process.exit(0)))
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
