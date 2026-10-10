import { runIngressCommand } from './commands.js'
try {
  runIngressCommand(process.argv.slice(2))
} catch {
  // Source and config errors can contain sensitive values; don't echo arbitrary text.
  console.error('Ingress maintenance failed; verify command, package and registry')
  process.exitCode = 1
}
