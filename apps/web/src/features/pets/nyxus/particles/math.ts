export const TAU = Math.PI * 2

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

export function mulberry32(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value += 0x6d2b79f5
    let result = value
    result = Math.imul(result ^ (result >>> 15), result | 1)
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

export function mixHexColor(from: string, to: string, amount: number): string {
  const fromValue = Number.parseInt(from.slice(1), 16)
  const toValue = Number.parseInt(to.slice(1), 16)
  const channel = (shift: number) => {
    const start = (fromValue >> shift) & 255
    const end = (toValue >> shift) & 255
    return Math.round(start + (end - start) * amount)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(16)}${channel(8)}${channel(0)}`
}

export function mixAngle(from: number, to: number, amount: number): number {
  const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + difference * amount
}
