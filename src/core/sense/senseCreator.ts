import { z } from 'zod'
import { SupervisionLevel } from '../config'

/**
 * 感官执行结果
 *
 * hash 可选：
 * - 提供 hash = 触发历史去重（见 [tool.ts doExecuteSense](../../agent/middleware/tool.ts)，
 *   用于 read_file 等"内容稳定"型 sense）。命中同 hash 旧消息折叠为短说明。
 * - 不提供 hash = 不参与去重（适用于 spawn_role 等"派发标识"型 sense——见 [core/sense.md hash 语义约束](../../docs/core/sense.md)）。
 */
export interface SenseResult {
  content: string
  hash?: string
}

export interface SenseFunction {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: {
        [key: string]: {
          type?: string | string[]
          items?: unknown
          description?: string
          enum?: unknown[]
        }
      }
      required: string[]
      additionalProperties: boolean
    }
  }
}

/** Sense间共享数据结构 */
export type SenseSharedData = Map<string, Map<string, unknown>>

/**
 * 感官运行时上下文（P2-11：注入边界，取代 sharedData 注入 chatId 的临时方案）。
 *
 * executor 第 3 参数（optional，向后兼容 2-param handler）。当前仅 chatId；
 * workspaceRoot/config/logger/abortSignal 待产品决策后扩展（多 workspace / 热重载场景）。
 */
export interface SenseRuntimeContext {
  /** 当前 chatId（bash 等需按会话归属的 sense 读取） */
  chatId: string
  /**
   * 请求 loop 在本轮 runChain 后立即结束（yield turn）。
   * spawn_role wait=true 调：主 agent 立即结束本 turn，子完成后由后端注入角色回复唤起新一轮
   * （见 docs/agent-pet.md §5.4）。senseMiddleware 提供闭包，置 ctx.soul.yieldTurn=true，loop 读取。
   */
  yieldTurn?: () => void
  /**
   * 当前 sense call id（= 主 chat sense message.id）。
   * spawn_role 等需回写自身关联（写到子 chat metadata，供后续 role_reply 透传前端）；
   * 前端 F 改动（点击 role 子头像 smooth scroll 回主 chat 的 sense 调用框）依赖此字段。
   * 缺省 → sense 不关注 messageId。
   */
  messageId?: string
}

export interface SenseExecutor<T extends z.ZodType> {
  schema: T
  /** execute：第 3 参数 ctx 为运行时上下文（optional，2-param handler 向后兼容） */
  execute: (
    input: z.infer<T>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>
}

export interface Sense<T extends z.ZodType> {
  definition: SenseFunction
  executor: SenseExecutor<T>
  /** Sense自身声明的监管等级（未声明时由外部 fallback 到 global || confirm） */
  supervisionLevel: SupervisionLevel | undefined
}

export function sense<T extends z.ZodType>(
  name: string,
  description: string,
  schema: T,
  handler: (
    input: z.infer<T>,
    senseSharedData: SenseSharedData,
    ctx?: SenseRuntimeContext,
  ) => Promise<SenseResult>,
  supervisionLevel?: SupervisionLevel,
): Sense<T> {
  const jsonSchema = (schema as any).toJSONSchema()

  const definition: SenseFunction = {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: jsonSchema.type ?? 'object',
        properties: jsonSchema.properties ?? {},
        required: jsonSchema.required ?? [],
        additionalProperties: false,
      },
    },
  }

  const executor: SenseExecutor<T> = {
    schema,
    execute: handler,
  }

  return {
    definition,
    executor,
    supervisionLevel,
  }
}
