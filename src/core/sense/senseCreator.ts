import { z } from 'zod'
import { SupervisionLevel } from '../config'
import type { ToolAuthorization } from '../security/rolePolicy.js'

/**
 * 感官执行结果
 *
 * hash 可选：
 * - 提供 hash = 触发历史去重（见 [tool.ts doExecuteSense](../../agent/middleware/tool.ts)，
 *   用于 read_file 等"内容稳定"型 sense）。命中同 hash 旧消息折叠为短说明。
 * - 不提供 hash = 不参与去重（适用于 spawn_role 等"派发标识"型 sense——见 [core/sense.md hash 语义约束](../../docs/backend/core/sense.md)）。
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
 * 工具能力声明：工具自己描述「接收什么、产出什么、是否前置执行、每批容量」。
 *
 * - `accepts`：接收的媒体类型（image/video/audio）或文件后缀（doc/docx/pdf…）。
 *   用于前置调度匹配（preprocess=true 时按实际媒体类型/后缀匹配）与发送门控判断。
 * - `produces`：产出的媒体类型（image/video/audio）或 text。生成类工具注入判断
 *   以工具自身 produces 声明为准（大脑 generate.* 标记不再作为注入门）。
 * - `preprocess`：是否前置执行（缺省 false = 普通后置工具，模型按需调用）。
 *   前置工具在发请求前执行，结果替换进消息（理解类媒体在非多模态模型下的处理路径）。
 * - `batchSize`：每批最多同时处理多少媒体项（缺省 = 一次性全量处理）。
 *   仅影响工具内部实现（分批调用外部接口），调度层永远全量传入。
 */
export interface SenseCapabilities {
  accepts?: string[]
  produces?: string[]
  preprocess?: boolean
  batchSize?: number
}

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
   * （见 docs/shared/architecture/agent-orchestration.md §5.4）。senseMiddleware 提供闭包，置 ctx.soul.yieldTurn=true，loop 读取。
   */
  yieldTurn?: () => void
  /**
   * 当前 sense call id（= 主 chat sense message.id）。
   * spawn_role 等需回写自身关联（写到子 chat metadata，供后续 role_reply 透传前端）；
   * 前端 F 改动（点击 role 子头像 smooth scroll 回主 chat 的 sense 调用框）依赖此字段。
   * 缺省 → sense 不关注 messageId。
   */
  messageId?: string
  /** 已在统一工具门完成复核的本次授权；执行器只能消费，不能自行扩大。 */
  security?: ToolAuthorization
  /** 当前会话的规范工作区根目录。需要文件系统或命令执行的工具必须 fail closed。 */
  workspaceRoot?: string
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
  /** Sense自身声明的监管等级（未声明时由外部 fallback 到 global || smart） */
  supervisionLevel: SupervisionLevel | undefined
  /** 工具能力声明：接收/产出类型、是否前置执行、每批容量（缺省 undefined = 无声明） */
  capabilities?: SenseCapabilities
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
  capabilities?: SenseCapabilities,
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
    ...(capabilities ? { capabilities } : {}),
  }
}
