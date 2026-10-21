import { runIngressCommand } from './commands.js'
import { initializeBackendEnvironment } from '../../../../../scripts/lib/backend-layout.mjs'
try {
  initializeBackendEnvironment(import.meta.url)
  runIngressCommand(process.argv.slice(2))
} catch {
  // Source and config errors can contain sensitive values; don't echo arbitrary text.
  console.error('Ingress maintenance failed; verify command, package and registry')
  process.exitCode = 1
}
