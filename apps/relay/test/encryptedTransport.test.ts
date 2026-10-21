import { describe, expect, it } from 'vitest'
import { validateEncryptedTransport } from '../src/encryptedTransport.js'
const key = Buffer.alloc(32, 7).toString('base64')
describe('authenticated tunnel transport', () => {
  it('accepts pinned Noise NK and rejects downgrade, wrong side and injected services', () => {
    const input = `[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = "${key}"\n`
    expect(validateEncryptedTransport(input, 'client')).toContain(key)
    for (const raw of [input.replace('noise', 'tcp'), input.replace(key, 'wrong'), input + '[client.services.extra]\ntoken = "secret"\n', input + 'pattern = "Noise_XX_25519_ChaChaPoly_BLAKE2s"\n']) expect(() => validateEncryptedTransport(raw, 'client')).toThrow()
    expect(() => validateEncryptedTransport(input, 'server')).toThrow()
  })
  it('requires TLS server identity and client CA plus hostname', () => {
    expect(() => validateEncryptedTransport('[client.transport]\ntype = "tls"\n[client.transport.tls]\ntrusted_root = "ca.pem"\n', 'client')).toThrow()
    expect(validateEncryptedTransport('[client.transport]\ntype = "tls"\n[client.transport.tls]\ntrusted_root = "ca.pem"\nhostname = "relay.example"\n', 'client')).toContain('relay.example')
  })
})
