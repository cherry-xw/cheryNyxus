import type { CommandLogChunk, CommandLogGap } from '@chery/protocol'

export const COMMAND_VIEW_BYTES = 1024 * 1024

export function mergeCommandChunks(previous: CommandLogChunk[], incoming: CommandLogChunk[]) {
  const unique = new Map(previous.map(chunk => [chunk.sequence, chunk]))
  for (const chunk of incoming) unique.set(chunk.sequence, chunk)
  const chunks = [...unique.values()].sort((a, b) => a.sequence - b.sequence)
  let bytes = chunks.reduce((sum, chunk) => sum + chunk.byteEnd - chunk.byteStart, 0)
  let trimmed = false
  while (chunks.length > 512 || bytes > COMMAND_VIEW_BYTES) {
    const removed = chunks.shift()!
    bytes -= removed.byteEnd - removed.byteStart
    trimmed = true
  }
  return { chunks, trimmed }
}

/** Retain only known missing ranges around the displayed page, subtracting live bytes we still have. */
export function mergeCommandGaps(chunks: CommandLogChunk[], gaps: CommandLogGap[]): CommandLogGap[] {
  if (!chunks.length) return gaps.slice(-512)
  const first = chunks[0]!, last = chunks.at(-1)!
  const result: CommandLogGap[] = []
  for (const gap of gaps) {
    let edge = { sequence: gap.sequenceStart, byte: gap.byteStart, line: gap.lineStart }
    for (const chunk of chunks) {
      if (chunk.sequence < edge.sequence || chunk.sequence > gap.sequenceEnd) continue
      if (chunk.sequence > edge.sequence) result.push({ sequenceStart: edge.sequence, sequenceEnd: chunk.sequence - 1,
        byteStart: edge.byte, byteEnd: chunk.byteStart, lineStart: edge.line, lineEnd: chunk.lineStart })
      edge = { sequence: chunk.sequence + 1, byte: chunk.byteEnd, line: chunk.lineEnd }
    }
    if (edge.sequence <= gap.sequenceEnd) result.push({ sequenceStart: edge.sequence, sequenceEnd: gap.sequenceEnd,
      byteStart: edge.byte, byteEnd: gap.byteEnd, lineStart: edge.line, lineEnd: gap.lineEnd })
  }
  return [...new Map(result.filter(gap => gap.sequenceEnd >= first.sequence - 1 && gap.sequenceStart <= last.sequence + 1)
    .map(gap => [`${gap.sequenceStart}:${gap.sequenceEnd}`, gap])).values()]
    .sort((a, b) => a.sequenceStart - b.sequenceStart).slice(-512)
}

/** Decode each stream incrementally; neither UTF-8 nor ANSI escapes are trusted markup. */
export function commandLogText(chunks: CommandLogChunk[], gaps: CommandLogGap[]): string {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() }
  const output: string[] = []
  let last: CommandLogChunk | undefined
  for (const chunk of chunks) {
    if (last && chunk.sequence !== last.sequence + 1) {
      output.push(decoders.stdout.decode(), decoders.stderr.decode(), '\n[此处日志缺失，详见缺失区间]\n')
    }
    const raw = Uint8Array.from(atob(chunk.dataBase64), char => char.charCodeAt(0))
    const text = decoders[chunk.stream].decode(raw, { stream: true })
    // Keep stdout/stderr attribution without inserting labels into every partial line.
    if (!last || last.stream !== chunk.stream) output.push(`\n[${chunk.stream}] `)
    output.push(text)
    last = chunk
  }
  output.push(decoders.stdout.decode(), decoders.stderr.decode())
  if (!chunks.length && gaps.length) output.push('[该范围的原始日志已不可用]')
  return output.join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}
