import { IngressStore } from './store.js'

/** Maintenance has no core config import and never starts services or executes packages. */
export function runIngressCommand(args: readonly string[], store = new IngressStore()): void {
  const [command, operand, digest, ...extra] = args.filter((arg) => arg !== '--')
  if (extra.length) throw new Error('Unexpected ingress arguments')
  if (command === 'install' || command === 'upgrade') {
    if (!operand) throw new Error('A built ESM package directory is required')
    if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest))
      throw new Error('Expected SHA-256 digest is invalid')
    const installed = store.install(operand, command === 'upgrade', digest)
    console.log(
      JSON.stringify({
        id: installed.id,
        version: installed.version,
        enabled: installed.enabled,
        packageDigest: installed.packageDigest,
        requiresRestart: true,
      }),
    )
    return
  }
  if (command === 'enable' || command === 'disable' || command === 'uninstall') {
    if (!operand || digest) throw new Error('Exactly one plugin ID is required')
    if (command === 'uninstall') store.uninstall(operand)
    else store.setEnabled(operand, command === 'enable')
    console.log(
      JSON.stringify({
        id: operand,
        command,
        requiresRestart: true,
        retainedConfigurationAndData: true,
      }),
    )
    return
  }
  if (command === 'status') {
    if (digest) throw new Error('Unexpected ingress arguments')
    const registry = store.readRegistry()
    if (operand && !registry.plugins.some((plugin) => plugin.id === operand))
      throw new Error('Plugin is not installed')
    console.log(
      JSON.stringify({
        revision: registry.revision,
        plugins: registry.plugins
          .filter((plugin) => !operand || plugin.id === operand)
          .map((plugin) => ({
            id: plugin.id,
            installed: true,
            enabled: plugin.enabled,
            savedVersion: plugin.version,
            packageDigest: plugin.packageDigest,
            activeVersion: null,
            state: 'unknown',
            requiresRestart: null,
          })),
      }),
    )
    return
  }
  throw new Error(
    'Usage: ingress install|upgrade <directory> [sha256] | enable|disable|uninstall <id> | status [id]',
  )
}
