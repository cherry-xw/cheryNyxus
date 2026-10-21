import { StringDecoder } from 'node:string_decoder'
import { stripVTControlCharacters } from 'node:util'
import type { CommandDrainSummary } from '@chery/protocol'
import { TemplateMiner } from './templateMiner'
import { TemplateMinerConfig } from './templateMinerConfig'

type Stream = 'stdout' | 'stderr'
type Template = CommandDrainSummary['templates'][number]

interface StreamState {
  decoder: StringDecoder
  pending: string
  discarding: boolean
}

const MAX_LINE_CHARS = 4096
const MAX_LINES_PER_WRITE = 2048
const MAX_CLUSTERS = 200

/** Incremental, bounded, lossy view; none of its text is used as original-log storage. */
export class StreamingDrain {
  private readonly miners = {
    stdout: this.createMiner(),
    stderr: this.createMiner(),
  }
  private readonly ready = Promise.all([this.miners.stdout.initialize(), this.miners.stderr.initialize()])
    .catch(() => { this.state = 'failed' })
  private readonly streams: Record<Stream, StreamState> = {
    stdout: { decoder: new StringDecoder('utf8'), pending: '', discarding: false },
    stderr: { decoder: new StringDecoder('utf8'), pending: '', discarding: false },
  }
  private readonly templates = new Map<number, Template>()
  private state: CommandDrainSummary['status'] = 'active'
  private lineCount = 0
  private skippedLineCount = 0
  private truncatedLineCount = 0
  private retiredLineCount = 0
  private finished = false

  /** The recorder serializes writes. Input must already be sanitized. */
  async write(stream: Stream, data: Buffer): Promise<void> {
    if (this.state === 'failed' || this.finished) return
    try {
      await this.ready
      if (this.snapshot().status === 'failed') return
      await this.accept(stream, this.streams[stream].decoder.write(data))
    } catch {
      this.state = 'failed'
    }
  }

  async finish(): Promise<CommandDrainSummary> {
    if (this.finished || this.state === 'failed') return this.snapshot()
    this.finished = true
    try {
      await this.ready
      if (this.snapshot().status === 'failed') return this.snapshot()
      for (const stream of ['stdout', 'stderr'] as const) {
        const source = this.streams[stream]
        await this.accept(stream, source.decoder.end())
        if (source.pending) await this.line(stream, source.pending)
        source.pending = ''
      }
      await Promise.all([this.miners.stdout.close(), this.miners.stderr.close()])
      this.state = this.state === 'partial' || this.skippedLineCount || this.truncatedLineCount || this.retiredLineCount ? 'partial' : 'complete'
    } catch { this.state = 'failed' }
    return this.snapshot()
  }

  /** Dropped raw chunks also make the summary incomplete, without inventing missing line counts. */
  markIncomplete(): void {
    if (this.state !== 'failed') this.state = 'partial'
  }

  /** Call in input order after a missing range; never splice its two halves into one line. */
  gap(stream: Stream): void {
    this.markIncomplete()
    this.streams[stream] = { decoder: new StringDecoder('utf8'), pending: '', discarding: false }
  }

  private createMiner(): TemplateMiner {
    return new TemplateMiner(new TemplateMinerConfig({
      drainSimTh: 0.5, drainDepth: 4, parametrizeNumericTokens: true, drainMaxClusters: MAX_CLUSTERS / 2,
    }))
  }

  snapshot(): CommandDrainSummary {
    return {
      status: this.state, lineCount: this.lineCount, skippedLineCount: this.skippedLineCount,
      truncatedLineCount: this.truncatedLineCount, retiredLineCount: this.retiredLineCount,
      templates: [...this.templates.values()].map((template) => ({ ...template, samples: [...template.samples] })),
    }
  }

  private async accept(stream: Stream, text: string): Promise<void> {
    const source = this.streams[stream]
    let offset = 0
    let processed = 0
    while (offset < text.length) {
      const newline = text.indexOf('\n', offset)
      const end = newline === -1 ? text.length : newline
      if (!source.discarding) {
        const room = MAX_LINE_CHARS - source.pending.length
        source.pending += text.slice(offset, Math.min(end, offset + room))
        if (end - offset > room) {
          source.discarding = true
          this.truncatedLineCount += 1
        }
      }
      if (newline === -1) break
      if (processed < MAX_LINES_PER_WRITE) {
        await this.line(stream, source.pending)
        processed += 1
      } else {
        this.lineCount += 1
        this.skippedLineCount += 1
      }
      source.pending = ''
      source.discarding = false
      offset = newline + 1
    }
  }

  private async line(stream: Stream, raw: string): Promise<void> {
    this.lineCount += 1
    const text = stripVTControlCharacters(raw).replace(/\r$/, '')
    if (!text.trim()) return
    const miner = this.miners[stream]
    const { logCluster: cluster } = await miner.addLogMessage(text)
    const id = cluster.id * 2 + (stream === 'stderr' ? 1 : 0)
    const current = new Set(miner.getClusters().map((entry) => entry.id * 2 + (stream === 'stderr' ? 1 : 0)))
    for (const [clusterId, template] of this.templates) {
      if (template.stream === stream && !current.has(clusterId)) {
        this.retiredLineCount += template.count
        this.templates.delete(clusterId)
      }
    }
    const template = this.templates.get(id) ?? { id, stream, template: '', count: 0, samples: [] }
    template.template = cluster.template.join(' ')
    template.count += 1
    if (template.samples.length < 3) template.samples.push(text)
    this.templates.set(id, template)
  }
}
