import { loadRelayConfig } from './config.js'
import { createRelayService } from './server.js'

export * from './adapter.js'
export * from './config.js'
export * from './errors.js'
export * from './identityStore.js'
export * from './logger.js'
export * from './registry.js'
export * from './server.js'
export * from './rathole.js'
export * from './client.js'

async function main(): Promise<void> {
  const config = loadRelayConfig()
  const service = await createRelayService({ config })
  const address = await service.listen()
  process.stdout.write(
    `${JSON.stringify({ event: 'relay_listening', host: address.address, port: address.port, basePath: config.publicBasePath })}\n`,
  )
  const shutdown = async () => {
    await service.close()
    process.exit(0)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

const entry = process.argv[1] ? new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href : ''
if (entry === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: 'relay_start_failed', error: (error as Error).message })}\n`)
    process.exit(1)
  })
}
