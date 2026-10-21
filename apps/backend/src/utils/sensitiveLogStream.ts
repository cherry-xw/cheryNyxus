interface Pattern {
  bytes: Buffer
  kind: 'key' | 'value'
}

/** Bounded by the configured secret lengths, not by log volume or line length. */
export class SensitiveLogStream {
  private pending = Buffer.alloc(0)
  private lastByte: number | undefined
  private afterKey = false
  private suppressValue = false
  private ended = false
  private readonly patterns: Pattern[]

  constructor(env: Record<string, string>, minimumBareLength: number) {
    const sensitive = Object.entries(env).filter(([key, value]) => /KEY|SECRET|TOKEN|PASSWORD|AUTH/i.test(key) && value &&
      value !== '[REDACTED]' && !'[REDACTED]'.includes(value))
    this.patterns = sensitive.flatMap(([key, value]): Pattern[] => [
      { bytes: Buffer.from(key), kind: 'key' },
      ...(value.length >= minimumBareLength ? [{ bytes: Buffer.from(value), kind: 'value' as const }] : []),
    ]).sort((a, b) => b.bytes.length - a.bytes.length)
  }

  write(data: Buffer): Buffer {
    if (this.ended) return Buffer.alloc(0)
    return this.accept(data, false)
  }

  end(): Buffer {
    if (this.ended) return Buffer.alloc(0)
    this.ended = true
    return this.accept(Buffer.alloc(0), true)
  }

  private accept(data: Buffer, final: boolean): Buffer {
    if (!this.patterns.length) return Buffer.from(data)
    const input = this.pending.length ? Buffer.concat([this.pending, data]) : data
    this.pending = Buffer.alloc(0)
    const output: Buffer[] = []
    let start = 0
    let offset = 0
    const flush = () => { if (offset > start) output.push(input.subarray(start, offset)); start = offset }
    while (offset < input.length) {
      const byte = input[offset]!
      if (this.suppressValue) {
        flush()
        if (byte === 10 || byte === 13) {
          this.suppressValue = false
          start = offset
        } else {
          this.lastByte = byte
          offset += 1
          start = offset
          continue
        }
      }
      if (this.afterKey) {
        if (byte === 32 || byte === 9) { this.lastByte = byte; offset += 1; continue }
        this.afterKey = false
        if (byte === 61) {
          offset += 1
          flush()
          output.push(Buffer.from('[REDACTED]'))
          this.suppressValue = true
          this.lastByte = byte
          continue
        }
      }
      let matched: Pattern | undefined
      let incomplete = false
      for (const pattern of this.patterns) {
        if (pattern.kind === 'key' && this.isWord(this.lastByte)) continue
        const length = Math.min(pattern.bytes.length, input.length - offset)
        if (!input.subarray(offset, offset + length).equals(pattern.bytes.subarray(0, length))) continue
        if (length < pattern.bytes.length) {
          if (!final) incomplete = true
          continue
        }
        matched = pattern
        break
      }
      if (incomplete && !final) {
        flush()
        this.pending = Buffer.from(input.subarray(offset))
        start = input.length
        break
      }
      if (matched) {
        flush()
        this.lastByte = matched.bytes[matched.bytes.length - 1]
        offset += matched.bytes.length
        if (matched.kind === 'value') output.push(Buffer.from('[REDACTED]'))
        else { output.push(matched.bytes); this.afterKey = true }
        start = offset
      } else {
        this.lastByte = byte
        offset += 1
      }
    }
    if (start < input.length) output.push(input.subarray(start))
    return Buffer.concat(output)
  }

  private isWord(byte: number | undefined): boolean {
    return byte !== undefined && ((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) ||
      (byte >= 97 && byte <= 122) || byte === 95)
  }
}
