import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { writeYaml } from './credentials.js'
import { withConfigTransaction } from '../../backend/src/utils/configTransaction.js'

export interface BackendPluginConfig {
  autoStart: boolean
}

const DEFAULT_AUTO_START = true

/**
 * `manager.backendPlugin` 分区读写：仅改动自身字段，写入走跨进程配置事务锁并回读确认。
 */
export class BackendPluginConfigStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async view(): Promise<BackendPluginConfig> {
    const config = await this.readConfig()
    const section = asRecord(asRecord(config.manager).backendPlugin)
    return { autoStart: typeof section.autoStart === 'boolean' ? section.autoStart : DEFAULT_AUTO_START }
  }

  async save(input: unknown): Promise<BackendPluginConfig> {
    const work = this.queue.then(() =>
      withConfigTransaction(this.file, async () => {
        if (typeof input !== 'object' || input === null || Array.isArray(input))
          throw new Error('config 必须是对象')
        const value = (input as Record<string, unknown>).autoStart
        if (typeof value !== 'boolean') throw new Error('autoStart 必须是布尔值')
        const config = await this.readConfig()
        const manager = asRecord(config.manager)
        manager.backendPlugin = { ...asRecord(manager.backendPlugin), autoStart: value }
        config.manager = manager
        await writeYaml(this.file, config)
        const readback = await this.view()
        if (readback.autoStart !== value) throw new Error('保存结果未确认')
        return readback
      }),
    )
    this.queue = work.catch(() => {})
    return work
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    const parsed = yaml.load(raw)
    if (parsed === undefined || parsed === null) return {}
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config.yaml 根节点必须是对象')
    return parsed as Record<string, unknown>
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
