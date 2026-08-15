import { randomUUID } from 'node:crypto'
import { AgentBuilder } from '@/agent/builder.js'
import type { RoleConfig } from '@/utils/config.js'
import type { LLMResponse } from '@/core/message/adapter'
import type { MiddlewareChunk } from '@/core/middleware/types.js'

export interface ShadowRunOptions<TResult> {
  roleName: string
  role: RoleConfig
  systemPrompt: string
  input: string
  correctiveInput?: string
  maxTurns?: number
  timeoutMs?: number
  /** Shadow 流式增量回调；调用方据此实时转发 thinking/content（不落库、不广播）。 */
  onChunk?: (chunk: MiddlewareChunk) => void
  setup(runId: string): void
  readResult(runId: string): TResult | undefined
  cleanup(runId: string): void
}

export interface ShadowRunResult<TResult> {
  runId: string
  result: TResult
  /** Shadow 的规范化消息快照；调用方只能投影必要字段，禁止直接对外暴露。 */
  messages: LLMResponse[]
}

/**
 * 进程内临时 Agent 流程。它只复用 AgentBuilder/AgentSession loop，不注册 Chat runtime，
 * 不进入 observer/streamMapper，因而不会产生 DB、Pet、节点树或 WebSocket 副作用。
 */
export class ShadowRunner {
  async run<TResult>(options: ShadowRunOptions<TResult>): Promise<ShadowRunResult<TResult>> {
    const runId = `shadow-${randomUUID()}`
    const maxTurns = Math.max(1, options.maxTurns ?? 2)
    const timeoutMs = options.timeoutMs ?? 25_000
    const builder = new AgentBuilder()
      .build({ maxLoopCount: 1 })
      .configureRuntime(
        {
          brain: options.role.brain,
          senseGroup: options.role.senseGroup,
          mcpServers: options.role.mcpServers ?? [],
        },
        false,
      )
      .initEphemeral(runId, options.systemPrompt)

    let timer: ReturnType<typeof setTimeout> | undefined
    let setupStarted = false
    try {
      setupStarted = true
      options.setup(runId)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          builder.abort()
          reject(new Error(`${options.roleName} Shadow 执行超时`))
        }, timeoutMs)
      })

      const execute = async (): Promise<ShadowRunResult<TResult>> => {
        for (let turn = 0; turn < maxTurns; turn++) {
          const prompt = turn === 0 ? options.input : options.correctiveInput
          if (!prompt) break
          for await (const chunk of builder.run(prompt)) {
            // Shadow chunks 不使用但转发给调用方（实时 thinking/content，供前端路由小窗）。
            options.onChunk?.(chunk)
          }
          const result = options.readResult(runId)
          if (result !== undefined) return { runId, result, messages: builder.getMessages() }
        }
        throw new Error(`${options.roleName} Shadow 未调用终止工具`)
      }

      return await Promise.race([execute(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
      if (setupStarted) options.cleanup(runId)
    }
  }
}
