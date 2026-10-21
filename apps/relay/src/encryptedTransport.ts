const key32 = /^[A-Za-z0-9+/]{43}=$/
/** Deliberately small supported TOML subset: no arbitrary service or TCP blocks. */
export function validateEncryptedTransport(raw: string, side: 'client' | 'server'): string {
  if (raw.length > 8192) throw new Error('Tunnel transport too large')
  const sections = new Map<string, Map<string, string>>()
  let current: Map<string, string> | undefined
  for (const original of raw.split(/\r?\n/)) {
    const line = original.trim()
    if (!line || line.startsWith('#')) continue
    const header = /^\[([a-z.]+)\]$/.exec(line)
    if (header) {
      if (![`${side}.transport`, `${side}.transport.noise`, `${side}.transport.tls`].includes(header[1]!)) throw new Error('Unexpected tunnel section')
      if (sections.has(header[1]!)) throw new Error('Duplicate tunnel section')
      current = new Map(); sections.set(header[1]!, current); continue
    }
    const field = /^([a-z0-9_]+)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(line)
    if (!field || !current || current.has(field[1]!)) throw new Error('Invalid tunnel transport field')
    const value = JSON.parse(field[2]!)
    if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) throw new Error('Invalid transport value')
    current.set(field[1]!, value)
  }
  const root = sections.get(`${side}.transport`)
  const type = root?.get('type')
  if (root?.size !== 1 || !['noise', 'tls'].includes(type ?? '') || sections.size !== 2) throw new Error('Explicit authenticated Noise or TLS required')
  const detail = sections.get(`${side}.transport.${type}`)
  if (!detail) throw new Error('Missing encrypted transport details')
  const allowed = type === 'noise' ? [side === 'client' ? 'remote_public_key' : 'local_private_key', 'pattern'] : side === 'client' ? ['trusted_root', 'hostname'] : ['pkcs12', 'pkcs12_password']
  if ([...detail.keys()].some((key) => !allowed.includes(key))) throw new Error('Unsupported transport option')
  if (type === 'noise') {
    const key = detail.get(allowed[0]!)
    if (!key || !key32.test(key) || Buffer.from(key, 'base64').length !== 32 || (detail.has('pattern') && detail.get('pattern') !== 'Noise_NK_25519_ChaChaPoly_BLAKE2s')) throw new Error('Authenticated Noise NK with a pinned 32-byte key required')
  } else if (side === 'client') {
    if (!detail.get('trusted_root') || !detail.get('hostname') || !/^[A-Za-z0-9.-]+$/.test(detail.get('hostname')!)) throw new Error('TLS requires a trusted root and verification hostname')
  } else if (!detail.get('pkcs12') || !detail.has('pkcs12_password')) throw new Error('TLS server identity required')
  return '\n' + [...sections].flatMap(([name, fields]) => [`[${name}]`, ...[...fields].map(([key, value]) => `${key} = ${JSON.stringify(value)}`), '']).join('\n')
}
