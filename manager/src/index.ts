import { createManager } from './server.js'

export * from './processController.js'
export * from './server.js'

const manager = createManager({ controlToken: process.env.CHERY_MANAGER_TOKEN })
void manager.listen().then(() => {
  process.stdout.write(JSON.stringify({ event: 'manager_listening', host: '127.0.0.1', port: 39980 }) + '\n')
})
process.once('SIGINT', () => void manager.close().then(() => process.exit(0)))
process.once('SIGTERM', () => void manager.close().then(() => process.exit(0)))
