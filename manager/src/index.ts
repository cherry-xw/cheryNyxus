import { createManager } from './server.js'
import { runManagerCli } from './cli.js'

export * from './processController.js'
export * from './server.js'
export * from './credentials.js'

async function startManager(): Promise<void> {
  const manager = createManager({
    controlToken: process.env.CHERY_MANAGER_TOKEN,
    relayStatusFile: process.env.CHERY_RELAY_STATUS_FILE,
    backendStatusFile: process.env.CHERY_BACKEND_STATUS_FILE,
  })
  await manager.listen()
  process.stdout.write(
    JSON.stringify({ event: 'manager_listening', host: '127.0.0.1', port: 39980 }) + '\n',
  )
  process.once('SIGINT', () => void manager.close().then(() => process.exit(0)))
  process.once('SIGTERM', () => void manager.close().then(() => process.exit(0)))
}

void runManagerCli(process.argv.slice(2))
  .then((handled) => {
    if (!handled) return startManager()
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
