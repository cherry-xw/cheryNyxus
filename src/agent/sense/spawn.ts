import { z } from 'zod'
import { randomUUID } from 'crypto'
import { sense, type SenseResult, type SenseSharedData } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { hashGenerator } from '@/utils/hash.js' // 仅复用条件 promptHash 仍用
import config from '@/utils/config.js'
import {
  createChat,
  findChatsByParent,
  getChatPreset,
  getChatSpawnTypes,
  getChatWorkspace,
  getChatRule,
  updateChatMetadata,
} from '@/db/chat.js'
import { emitRoleCreated, registerWaitedChild, startChildEager } from '@/agent/spawnBroker.js'
import { logger } from '@/utils/logger/index.js'
import { getSessionRoleRuntime, setEphemeralChatRuntime } from '@/service/chat/runtime.js'
import { createSpawnTask, getSpawnTaskByChild } from '@/db/delivery.js'
import { resolveRoleAvatar } from '@/utils/roleAvatar.js'

// tool 暴露面：让主 agent LLM 可见可用角色及能力（非盲串 type）。
// - type 用 z.enum(roles 键) 硬约束（空配置兜底 z.string()，z.enum([]) 构造抛错）
// - catalog = config.roles 全集（单一源，模块加载期冻结；预设按 type 引用，不在预设内重定义）。
//   sense 定义不支持 per-chat 动态，故 catalog 为全局全集让 LLM 可见所有类型；
//   实际可 spawn 类型由执行期 roster gate 强制（preset chat 限选中集，见 resolveSpawnRoster）。
// - description 运行时拼接 catalog（每类型 brain(input: ...) + senseGroup），
//   input 维度从 brain config 动态读取（image/video/audio），主 agent 据此判断媒体委派目标。
const roleCatalog = new Map<
  string,
  { brain: string; senseGroup: string; inputCapabilities: string[] }
>()
for (const [name, cfg] of Object.entries(config.roles ?? {})) {
  const brainCfg = config.llm.brain[cfg.brain]
  const inputCaps = Object.entries(brainCfg?.capabilities?.input ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k)
  roleCatalog.set(name, {
    brain: cfg.brain,
    senseGroup: cfg.senseGroup,
    inputCapabilities: inputCaps,
  })
}
const roleKeys = [...roleCatalog.keys()]
const typeSchema = roleKeys.length > 0 ? z.enum(roleKeys as [string, ...string[]]) : z.string()
const catalogText = roleKeys.length
  ? roleKeys
      .map((name) => {
        const c = roleCatalog.get(name)
        const inputStr = c?.inputCapabilities.length
          ? `(input: ${c.inputCapabilities.join('+')})`
          : '(input: none)'
        return `- ${name}: brain=${c?.brain}${inputStr}, senseGroup=${c?.senseGroup ?? ''}`
      })
      .join('\n')
  : '（未配置任何角色）'
const spawnDescription = `派发角色执行子任务（主 agent 一律本轮结束停等，子群并行跑；唤醒策略控制子完成后何时唤主）。
可用角色类型（每类型能力 = brain + senseGroup）：
${catalogText}
必填参数：
- type: 角色类型名（上方枚举的可用键）
- prompt: 交付角色的任务描述
- wake: 唤醒策略（控制子完成后是否/何时唤主）
  - immediate: 子完成立即唤主（聚合所有已完成子结果）。适合关键路径任务
  - deferred: 子完成结果暂存不唤主；全 deferred 集最后一个完成隐式唤主。适合后台任务
  - barrier: 声明栅栏，主进入 all 模式，所有未完成子完成才唤主。适合批量并行后汇总
  主一轮内可连续 spawn 多个子（本轮 LLM 结束后统一停等）；子结果都带 [角色 type] 来源说明注入主消息流。`

/**
 * 解析 chat 可 spawn 的角色 type 集（roster gate，执行期强制）。
 * - preset chat：metadata.spawnTypes 快照（编制锁定，chat.create 写入）；旧主 chat 无快照 → live 回读 presets[preset].roles。
 * - 子 chat（无 preset）→ 全集 config.roles（递归：子也可 spawn 子）。
 * 注：spawn sense 的 type enum 为模块加载期冻结的全集 catalog（LLM 可见全部），roster 仅执行期 gate。
 */
function resolveSpawnRoster(chatId: string): string[] {
  const presetName = getChatPreset(chatId)
  if (!presetName) return roleKeys // 子 chat → 全集可用
  const snap = getChatSpawnTypes(chatId)
  if (snap) return snap // 新主 chat：创建快照（编制锁定；显式空集 = 不可 spawn）
  return config.presets?.[presetName]?.roles ?? roleKeys // 旧主 chat：live 回读（无则全集兜底）
}

/**
 * spawn_role sense（主从 Agent 桌宠系统 CP3）
 *
 * 派发角色执行子任务。前端驱动架构（见 docs/agent-pet.md §2/§5.1/§5.4）：
 *   1. 后端创建子 chat 行（parent_chat_id 关联主 chat）+ 推 role_created notification
 *   2. 前端收 notification → 创建子 pet + 调 chat.startSpawn 原子领取任务（同 WS 连接按 chatId 路由 chunk）
 *   3. registerWaitedChild（带 wake 策略）+ yieldTurn（主 loop 本轮结束停等）；子完成后后端注入角色回复
 *      + wakeScheduler 按 wake 策略决定 silent 暂存（deferred/barrier）/ 推 role_reply 唤主跑新一轮
 *      （immediate/策略满足，见 docs/agent-pet.md §5.4 唤醒策略调度器）
 *
 * 不在后端 sense 内部跑子 agent（规避 sense 无法 trigger chat.send、跨连接 busy 锁两大风险）。
 */
export default sense(
  'spawn_role',
  spawnDescription,
  z.object({
    type: typeSchema.describe('角色类型名（上方枚举的可用键）'),
    prompt: z.string().describe('交付角色执行的任务描述'),
    wake: z
      .enum(['immediate', 'deferred', 'barrier'])
      .default('immediate')
      .describe(
        '唤醒策略：immediate(子完成立即唤主)/deferred(暂存,全完成兜底唤主)/barrier(栅栏,全完成唤主)',
      ),
  }),
  async (input, senseSharedData: SenseSharedData, ctx): Promise<SenseResult> => {
    // senseSharedData 在 spawn_role 中无业务用途（子 agent 独立 chat，不继承主 sense 共享状态）；
    // 保留参数为 sense() 工厂签名契约。void 显式标记"已用但为空实现"，避免 TS strict unused 检查告警。
    void senseSharedData
    const { type, prompt, wake } = input

    // ctx.chatId 是主 agent 当前 chatId（spawn 调用方）；缺省（异常调用场景）→ 抛错
    // 不静默兜底 chatId，避免子 chat 漂浮无 parent 溯源。先取 parentChatId 供预设解析。
    const parentChatId = ctx?.chatId
    if (!parentChatId) {
      throw new Error(
        'spawn_role 缺少主 chatId（SenseRuntimeContext.chatId 未注入，无法关联主 agent）',
      )
    }

    // 1. 角色定义恒从 config.roles[type] 单一源解析（fail loud，规则12）。
    //    roster gate：preset chat 限 metadata.spawnTypes 选中集（未选中 → fail loud）；
    //    子 chat（无 preset）→ 全集可用（递归：子也可 spawn 子）。
    // 先判 type 是否为干净枚举值（roleKeys 精确匹配）：LLM 偶发输出畸形 args（type 含换行/标签
    // 如 "planner\n<tool_input>\n..."）时 JSON.parse 仍成功，但 type 不是合法角色名。
    // 区分「格式错误」vs「未知角色」：畸形 blob 走格式错误分支，错误消息截断不含整个 blob，
    // 明确提示「合法 JSON + type 纯枚举」，引导 LLM 重试（规则 12 fail loud + 提示）。
    if (!roleKeys.includes(type)) {
      const preview = type.length > 40 ? `${type.slice(0, 40)}...` : type
      throw new Error(
        `spawn_role 参数格式错误：type 应为单一角色名（${roleKeys.join(' / ') || '（未配置任何角色）'}），` +
          `收到 "${preview}"。请输出合法 JSON：type 为纯字符串枚举值，prompt 为任务字符串（换行用 \\n 转义，` +
          `不得用 <tool_input> 等标签格式）。`,
      )
    }
    const roleCfg = config.roles?.[type]
    if (!roleCfg) {
      throw new Error(
        `没有 "${type}" 这个角色（可用：${roleKeys.join(', ') || '（未配置任何角色）'}）`,
      )
    }
    const roster = resolveSpawnRoster(parentChatId)
    if (!roster.includes(type)) {
      const presetName = getChatPreset(parentChatId)
      throw new Error(
        `"${type}" 不在${presetName ? `预设 "${presetName}" 的编制` : '可用角色集'}（可选：[${roster.join(', ')}]）`,
      )
    }
    const {
      brain: defaultBrain,
      senseGroup: defaultSenseGroup,
      mcpServers: defaultMcpServers = [],
      systemPrompt: systemPromptFile,
      skills: roleSkills,
      plugins: rolePlugins,
    } = roleCfg
    const avatar = resolveRoleAvatar(type, roleCfg.avatar)
    // per-role 技能组/插件组过滤（快照入子 chat metadata.skillFilter，<skills> 块按角色裁剪）
    const skillFilter =
      roleSkills !== undefined || rolePlugins !== undefined
        ? { skills: roleSkills, plugins: rolePlugins }
        : undefined
    const temporaryRuntime = getSessionRoleRuntime(parentChatId, type)
    const { brain, senseGroup } = temporaryRuntime ?? {
      brain: defaultBrain,
      senseGroup: defaultSenseGroup,
    }

    // 2. 创建子 chat 前,检查是否已有未完成的子 chat(避免重连/重发后重复创建)
    // 复用条件:type + prompt 都必相同(精确匹配)
    //   - parent_chat_id 匹配 + 未 finished(metadata.finished !== true)
    //   - type 相同:不同 type 是不同角色,不能复用(会污染子 agent 上下文)
    //   - promptHash 相同:不同 prompt 是不同任务(典型 fire-and-forget 多任务派发),即使 type 相同也不能复用
    //     —— 此前仅按 finished 匹配导致多任务全部挤到同一未完成子 chat,行为退化(见对话 90ecacf2)
    // 注:ChatRow 不含 type/prompt 字段,从 metadata 读(metadata.type / metadata.spawnPromptHash 在创建时写入)
    const inputPromptHash = hashGenerator('prompt', type, prompt)
    const existingChildren = findChatsByParent(parentChatId)
    const reusableChild = existingChildren.find((c) => {
      const metadata = c.metadata ? JSON.parse(c.metadata) : {}
      return (
        metadata.finished !== true &&
        metadata.type === type &&
        metadata.spawnPromptHash === inputPromptHash
      )
    })

    let childChatId: string
    if (reusableChild) {
      // 复用未完成子 chat(断连恢复场景)
      childChatId = reusableChild.id
      logger.event('spawn.reuse', { parentChatId, childChatId, type })
    } else {
      // 创建新子 chat 行 + 预配 runtime(metadata.runtime 路径同 chat.create handler)
      // 前端收 notification 后直接 chat.send(childChatId, prompt):ensureChat 检测 metadata.runtime
      // 已存在 → 自动恢复(getChatRuntimeSelection),无需前端再 chat.create(避 PRIMARY KEY 冲突)
      // 也无需 runtime.set。后端已有 roles[type].brain+senseGroups,预创建时一次配齐契约最简。
      // mcpServers 缺省 [](子 agent 默认不开 MCP,与主 agent 解耦)。
      childChatId = randomUUID()
      // systemPromptFile（per-role 专属 system prompt，绝对路径，来自 config.roles[type].systemPrompt 单一源；
      //   预设仅按 type 引用，无 per-preset 角色 systemPrompt 覆盖——故同一 type 的 persona 在所有引用它的预设生效；
      //   缺省 → undefined → 子 agent 用全局 system_prompt）。ensureChat 读 metadata.systemPromptFile 注入。
      // 子 agent 继承主 chat workspace（同项目，system prompt 注入同一工作区说明）
      const parentWorkspace = getChatWorkspace(parentChatId)
      const parentRule = getChatRule(parentChatId)
      createChat(
        childChatId,
        {
          // 持久化角色默认值；临时覆盖由下方 ephemeral runtime 接管，绝不写 DB。
          runtime: {
            brain: defaultBrain,
            senseGroup: defaultSenseGroup,
            mcpServers: defaultMcpServers,
          },
          ...(systemPromptFile ? { systemPromptFile: systemPromptFile } : {}),
          ...(skillFilter ? { skillFilter } : {}),
          ...(parentWorkspace ? { workspace: parentWorkspace } : {}),
          ...(parentRule ? { rule: parentRule } : {}),
          // T9.10 重启容错：wake+type 持久化，rebuildWaitedChildren 扫 metadata.wake 按策略重建唤醒链
          wake,
          type,
          // spawn 复用条件：type + spawnPromptHash 精确匹配（见上方 existingChildren.find）
          spawnPromptHash: inputPromptHash,
        },
        parentChatId,
      )
      // 记录完整 spawn 参数（创建新子chat时）
      logger.event('spawn.call', {
        parentChatId,
        childChatId,
        type,
        prompt: input.prompt,
        wake,
        brain,
        senseGroup,
        temporaryRuntime: !!temporaryRuntime,
      })
    }

    // 新建与复用子角色都使用当前会话的内存覆盖；不触碰其持久化默认编制。
    if (temporaryRuntime) setEphemeralChatRuntime(childChatId, temporaryRuntime)

    // task 是 role_created 的持久化权威载体：重连/事件重放不再依赖瞬时 notification。
    // 旧 child（创建于该表引入前）首次复用时补建任务，保持向后兼容。
    let task = getSpawnTaskByChild(childChatId)
    if (!task) {
      task = createSpawnTask({
        childChatId,
        parentChatId,
        type,
        prompt,
        brain,
        senseGroup,
      })
    }

    // 回写触发本次 spawn 的 sense call id 到子 chat metadata。
    // 新建分支：写入新 metadata 备用 + role_created 通知 + role_reply 唤醒时回读。
    // 复用分支：覆盖旧子 chat metadata（旧子可能存了上一轮 spawn id；用户断连重发触发同一子时新 id 应刷新）。
    // ctx?.messageId 缺省时（如外部/未注入 messageId 的 sense）→ undefined → 不写 key，前端兜底。
    const spawnSenseCallId = ctx?.messageId
    if (spawnSenseCallId) {
      updateChatMetadata(childChatId, { spawnSenseCallId })
    }

    // 3. 推 role_created notification(spawnBroker.broadcaster → 主 chat 所属连接 ws)
    emitRoleCreated({
      taskId: task.taskId,
      chatId: childChatId,
      parentChatId,
      type,
      avatar,
      prompt,
      brain,
      senseGroup,
      wake,
      spawnSenseCallId,
    })

    // 4. 注册唤醒链 + 启动看门狗（带唤醒策略 wake）。子完成后经 child_done → wakeScheduler 按 wake 策略
    //    决定 silent 暂存（deferred/barrier）/ resume 唤主（immediate/策略满足），见 docs/agent-pet.md §5.4。
    registerWaitedChild(childChatId, parentChatId, type, wake)

    // 5. eager 启动子 chat 后台运行（fire-and-forget）：用户原设计要求「子 agent 与主 agent 走同一 API」，
    //    原 chat.startSpawn 由前端驱动——若前端 RPC 失败（requestMap 时序 / 网络抖动 / 页面关闭），子 agent
    //    stream 永远到不了前端。把启动收敛到 sense 后端，端到端路径与 chat.send 完全一致：
    //    handleChatStartSpawn → handleChatSend → bindChatConnection 子 chatId → persistChatEvent + sendToWs 推
    //    到 parent ws；前端只通过 ws 订阅观察即可。chat.startSpawn RPC 不删除（保留 recovery / 重连抢占 / 已
    //    finished 同步 / 流加入）。未注入 starter 时仅 warn，由前端 chat.startSpawn RPC 兜底不影响主流程。
    startChildEager(task.taskId, parentChatId)

    // 主一律本轮结束停等（统一 yieldTurn）：主一轮内可连续 spawn 多个子，yieldTurn 累积，
    // 本轮 LLM 结束后 loop 检测 yieldTurn 统一停。子群并行跑，按 wake 策略唤主。
    ctx?.yieldTurn?.()
    // 不返回 hash：spawn 的"派发标识" hash 命中 ≠ 重复派发任务（实际可能是"不同任务复用未完成子 chat"），
    //   会导致 tool.ts replaceSense 错误折叠 sense 消息、丢失原始 prompt 参数（见对话 90ecacf2）。
    return {
      content: `角色 "${type}" 已派发（chatId=${childChatId}，唤醒策略=${wake}），本轮结束后等待子结果。`,
    }
  },
  SupervisionLevel.auto,
)
