export interface TerminalPreset {
  id: string
  label: string
  kind: 'local' | 'ssh'
  host: string
  port: number
  username: string
  auth: 'saved'
  credentialId?: string
}

export const TERMINAL_PRESETS_KEY = 'cherynyxus:terminal-presets:v1'
const TERMINAL_PRESETS_KEY_MATERIAL = 'cherynyxus:terminal-presets:key:v1'
export const TERMINAL_PRESETS_CHANGED_EVENT = 'cherynyxus:terminal-presets-changed'

function encode(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
}

async function getStorageKey(): Promise<CryptoKey | undefined> {
  if (typeof crypto === 'undefined' || !crypto.subtle || typeof localStorage === 'undefined') return
  let material = localStorage.getItem(TERMINAL_PRESETS_KEY_MATERIAL)
  if (!material) {
    const raw = crypto.getRandomValues(new Uint8Array(32))
    material = encode(raw)
    localStorage.setItem(TERMINAL_PRESETS_KEY_MATERIAL, material)
  }
  return crypto.subtle.importKey('raw', decode(material), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export async function readTerminalPresets(): Promise<TerminalPreset[]> {
  if (typeof localStorage === 'undefined') return []
  try {
    const stored = localStorage.getItem(TERMINAL_PRESETS_KEY)
    if (!stored) return []
    const parsedStored = JSON.parse(stored) as { iv?: string; data?: string }
    const key = await getStorageKey()
    if (!key || !parsedStored.iv || !parsedStored.data) return []
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decode(parsedStored.iv) },
      key,
      decode(parsedStored.data),
    )
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is TerminalPreset => {
      if (!item || typeof item !== 'object') return false
      const value = item as Partial<TerminalPreset>
      return (
        typeof value.id === 'string' &&
        typeof value.label === 'string' &&
        (value.kind === 'local' || value.kind === 'ssh') &&
        typeof value.host === 'string' &&
        typeof value.port === 'number' &&
        typeof value.username === 'string' &&
        value.auth === 'saved'
      )
    }).map((item) => {
      const { hostKey: _legacyHostKey, ...preset } = item as TerminalPreset & { hostKey?: unknown }
      return preset
    })
  } catch {
    return []
  }
}

export async function writeTerminalPresets(presets: TerminalPreset[]): Promise<void> {
  if (typeof localStorage === 'undefined') return
  try {
    const key = await getStorageKey()
    if (!key) return
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(presets)),
    )
    localStorage.setItem(
      TERMINAL_PRESETS_KEY,
      JSON.stringify({ iv: encode(iv), data: encode(new Uint8Array(data)) }),
    )
    window.dispatchEvent(new CustomEvent(TERMINAL_PRESETS_CHANGED_EVENT))
  } catch {
    // Locked or private storage must not prevent Terminal use.
  }
}
