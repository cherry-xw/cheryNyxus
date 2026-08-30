import type {
  MiddlewareContext,
  MiddlewareChunk,
  SenseTriggerChunk,
  SenseStartedChunk,
  StreamChunk,
} from '@/core/middleware/types'
import type { ReplaceInfo } from '@/core/message/adapter'
import { safeJsonParse } from '@/utils/json.js'
import { SupervisionLevel } from '@/core/config'
import { createApproval, isSafeSenseCall } from '@/core/sense'
import { logger } from '@/utils/logger/index.js'
import { redactEnvKeys } from '@/utils/envGuard.js'
import { checkCheryGuard } from '@/utils/pathGuard.js'
import { SenseCallAssembler } from './senseCallAssembler.js'
import { dispatch } from '@/agent/hooks/index.js'
import { ClassifiedError } from '@/utils/error.js'
import { authorizeToolCall, compileRoleSecurity, type ToolAuthorization } from '@/core/security/index.js'
import { getChatWorkspace } from '@/db/chat.js'
import config from '@/utils/config.js'
import { approvalPreview, approvalSnapshotMatches, type ApprovalSnapshot } from './approvalPreview.js'

/**
 * 待批量执行的 sense call
 */
interface PendingSenseCall {
  id: string
  name: string
  argsJson: string
  supervisionLevel: SupervisionLevel
  /** smart/manual 时存在，用于 Promise.all 批量等待审批 */
  approvalPromise?: Promise<{ action: 'accept' | 'reject'; reason?: string }>
  authorization: ToolAuthorization
  approvalSnapshot?: ApprovalSnapshot
  preDenied?: boolean
}

/**
 * 感官 hash 去重黑名单（不应触发 replaceSense 的 sense）。
 *
 * 背景：replaceSense 设计语义是"内容稳定可折叠"（典型如 read_file：文件未变 → 长内容冗余 → 折叠），
 *   但 hash 字段被泛化使用，导致一些"派发标识"型 sense 也返回 hash，命中误折叠。
 *   黑名单按 sense 名排除，避免 hash 语义错位的 sense 触发链式折叠（见对话 90ecacf2）。
 *
 * 当前黑名单：
 * - spawn_role：hash = hashGenerator("spawn_role", childChatId, type, mode)，仅是派发标识，
 *   命中 ≠ 重复派发任务（实际可能是"不同任务复用了同一未完成子 chat"），折叠会破坏原始 prompt 参数。
 */
const NON_DEDUPABLE_SENSES = new Set<string>(['spawn_role'])

/**
 * 配置管理核心角色判定：能力驱动（不依赖角色名，改名/仿冒免疫）。
 * senseTable 含 config_manage（结构化配置管理）或 install_skill（技能安装）即视为配置管理角色。
 * 两处授权（buildSenseTrigger 首次 / doExecuteSense 重授权）均从此函数**同源**计算，保证
 * filesystemRead override 一致 → assessmentHash 恒等 → 不误触「策略或参数已变化」校验。
 */
function isConfigManager(senseTable: { has(name: string): boolean }): boolean {
  return senseTable.has('config_manage') || senseTable.has('install_skill')
}

/**
 * Sense Middleware（批量模式）
 * 职责：
 * 1. Phase 1：从 stream chunks 收集 senseDelta，检测完整 sense call，yield sense_end 触发器
 * 2. Phase 2：流结束后，auto sense 先执行；smart/manual 批量 await Promise.all 等待审批后执行
 * pending sense 不再自动恢复执行，改由 chat.resume 撤回重跑（见 service/chat/send.ts handleChatResume）
 *
 * trace 日志：sense 触发/执行/拒绝由 chokepoint（streamMapper 的 sense.trigger/result/rejected）
 *   统一发射；此处仅发 chokepoint 不覆盖的 approval.wait（批量等待用户审批）。
 */
export async function* senseMiddleware(
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<MiddlewareChunk>,
): AsyncGenerator<MiddlewareChunk> {
  const collectedCalls: PendingSenseCall[] = []

  // resume 续接（chat.resume Case1：末尾有 pending sense）：
  // 首轮 skip chat 层（不调 next / 不调 LLM），从历史 pending 重建 trigger 执行。
  // 同默认审批流一致；工具不在当前 senseTable 静默写「无此工具」结果。
  if (ctx.soul.resumePending) {
    ctx.soul.resumePending = false
    yield* executeResumePending(ctx)
    return
  }

  // Phase 1: 收集 sense calls + yield sense_end 触发器
  // SenseCallAssembler 统一 tool.ts（流式 index 切换触发 sense_end）与 checkpointState.ts（批量合并落库）的 delta 合并语义。
  const assembler = new SenseCallAssembler()

  for await (const chunk of next()) {
    if (chunk.type === 'stream') {
      const streamChunk = chunk as StreamChunk
      if (streamChunk.senseDelta && streamChunk.senseDelta.length > 0) {
        for (const delta of streamChunk.senseDelta) {
          // index 切换：上一项 arguments 已完整，触发 sense_end
          const completed = assembler.flushCompletedOnIndexChange(delta)
          if (completed) {
            const { trigger, call } = buildSenseTrigger(
              ctx,
              completed.id ?? '',
              completed.name!,
              completed.arguments,
            )
            collectedCalls.push(call)
            yield trigger
          }
          assembler.push(delta)
        }
      }
    }

    yield chunk
  }

  // 流结束后，处理剩余的 sense calls
  for (const sc of assembler.toArray()) {
    if (sc.name) {
      const { trigger, call } = buildSenseTrigger(ctx, sc.id ?? '', sc.name!, sc.arguments)
      collectedCalls.push(call)
      yield trigger
    }
  }

  // Phase 2: 批量执行
  if (collectedCalls.length > 0) {
    yield* executeCollectedCalls(ctx, collectedCalls)
  }
}

/**
 * 批量执行收集到的 sense calls（Phase 2）
 */
async function* executeCollectedCalls(
  ctx: MiddlewareContext,
  calls: PendingSenseCall[],
): AsyncGenerator<MiddlewareChunk> {
  // Auto sense 先执行（不等待审批）
  const autoCalls = calls.filter((c) => c.supervisionLevel === SupervisionLevel.auto)
  for (const call of autoCalls) {
    if (call.preDenied) {
      yield {
        type: 'sense_reject',
        id: call.id,
        name: call.name,
        reason: call.authorization.findings.map((finding) => finding.message).join('；') || '角色策略禁止执行',
      }
      continue
    }
    const { content, hash, replaced, rejected } = yield* doExecuteSense(
      ctx,
      call.name,
      call.argsJson,
      call.id,
      call.authorization,
      call.approvalSnapshot,
    )
    if (rejected) {
      yield { type: 'sense_reject', id: call.id, name: call.name, reason: rejected }
      continue
    }
    yield { type: 'sense_accept', id: call.id, name: call.name, result: content, hash }
    // 被替换的历史 sense 消息：yield message_updated 让 observer 落库 replace 状态
    for (const r of replaced) {
      yield {
        type: 'message_updated',
        id: r.id,
        patch: {
          kind: 'replace',
          content: r.content,
          replace: r.replace,
          originalContent: r.originalContent,
        },
      }
    }
  }

  // Confirm/manual senses — 逐个审批执行（sequential：approve A→exec A→approve B→exec B）
  // 无 Promise.all 屏障：已批准 call 不被未决 call 阻塞（P1.9 互阻修复）。
  const needsApproval = calls.filter((c) => c.approvalPromise)
  if (needsApproval.length > 0) {
    logger.event('approval.wait', {
      count: needsApproval.length,
      approvals: needsApproval.map((c) => ({
        approvalId: c.id,
        name: c.name,
        supervisionLevel: c.supervisionLevel,
      })),
    })

    // sequential：逐个 await 执行，但断连 abort 可能在任意时刻 reject 某 call 的 promise
    // （如 A 执行期间断连 reject B，此时 B 的 await handler 尚未挂载）。预挂 no-op catch 防止
    // reject 早于 await 挂载 handler 触发 unhandled rejection；await 仍收到 rejection 并 throw
    // （同一 promise 多 handler 均触发，no-op catch 不影响 await 的 throw 语义）。
    for (const call of needsApproval) {
      call.approvalPromise!.catch(() => {})
    }

    for (const call of needsApproval) {
      // approvalPromise 结果：
      //   - resolve accept/reject（仅用户明确决定）→ 正常 yield sense_accept/sense_reject
      //   - reject AgentAbortError/AgentParkError（断连或资源回收）→ 抛出传播终止流程，pending NULL，resume Case1 重跑
      //     不 yield sense_reject：会填 pending content 破坏 canResume Case1（pending 需保持 NULL）。
      //     不 return：return 结束 senseMiddleware，loop 误判本轮完成继续第二轮 LLM，破坏未完成周期语义。
      //     已执行 call（序列靠前的）保持 done；未到达 call 保持 pending NULL，resume 续接重跑。
      const decision = await call.approvalPromise!

      if (decision.action === 'accept') {
        const { content, hash, replaced, rejected } = yield* doExecuteSense(
          ctx,
          call.name,
          call.argsJson,
          call.id,
          call.authorization,
          call.approvalSnapshot,
        )
        if (rejected) {
          yield { type: 'sense_reject', id: call.id, name: call.name, reason: rejected }
          continue
        }
        yield { type: 'sense_accept', id: call.id, name: call.name, result: content, hash }
        // 被替换的历史 sense 消息：yield message_updated 让 observer 落库 replace 状态
        for (const r of replaced) {
          yield {
            type: 'message_updated',
            id: r.id,
            patch: {
              kind: 'replace',
              content: r.content,
              replace: r.replace,
              originalContent: r.originalContent,
            },
          }
        }
      } else {
        yield {
          type: 'sense_reject',
          id: call.id,
          name: call.name,
          reason: '用户拒绝执行' + (decision.reason ? `理由:${decision.reason}` : ''),
        }
      }
    }
  }
}

/**
 * 续接执行末尾 pending sense（chat.resume Case1，首轮 skip chat 层）。
 * 从末尾向前收集连续空 content 的 sense 消息，重建 SenseTriggerChunk 执行。
 * 工具不在当前 senseTable → 跳过监管静默写「无此工具:{name}」结果（作 accept，
 *   checkpointState recovery 路径原地更新 pending → done，LLM 据此感知工具不存在）。
 */
async function* executeResumePending(ctx: MiddlewareContext): AsyncGenerator<MiddlewareChunk> {
  if (!ctx.runtime) throw new Error('Runtime not configured.')
  const messages = ctx.soul.messages ?? []
  const pending: { id: string; name: string; argsJson: string }[] = []

  // 末尾连续空 content 的 sense（pending）；遇 done（有 content）即停
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'sense') break
    if (m.content) break
    const sc = m.senseCalls?.[0]
    if (sc) {
      pending.unshift({ id: sc.id, name: sc.name, argsJson: sc.arguments })
    }
  }

  if (pending.length === 0) {
    return
  }

  const calls: PendingSenseCall[] = []
  for (const p of pending) {
    if (!ctx.runtime.senseTable.has(p.name)) {
      // 工具不在当前 senseTable：静默写占位结果
      yield { type: 'sense_accept', id: p.id, name: p.name, result: `工具已失效：${p.name}` }
      continue
    }
    const { trigger, call } = buildSenseTrigger(ctx, p.id, p.name, p.argsJson)
    calls.push(call)
    yield trigger
  }

  if (calls.length > 0) {
    yield* executeCollectedCalls(ctx, calls)
  }
}

/**
 * 构建 sense trigger + pending call（不执行）
 * trigger 携带 approvalResolve 供 service 层注册到 ApprovalManager
 * call 携带 approvalPromise 供 senseMiddleware 批量 await
 */
function buildSenseTrigger(
  ctx: MiddlewareContext,
  id: string,
  name: string,
  argsJson: string,
): { trigger: SenseTriggerChunk; call: PendingSenseCall } {
  if (!ctx.runtime) throw new Error('Runtime not configured.')
  const senseEntry = ctx.runtime.senseTable.get(name)
  const configuredLevel = senseEntry?.supervisionLevel ?? SupervisionLevel.smart
  const args = safeJsonParse(argsJson, {})

  // 运行时 schema 校验：审批创建前拦截缺参/非法参数调用（纵深防御）。
  // 背景：zod schema 转 JSON Schema 可能丢失 required（如 z.discriminatedUnion 顶层 required 缺失，
  //   见 docs/agent/prompt-guide.md 规范 #3），且 LLM 可能漏传必填参数（历史事故：config_manage 空调用）。
  // 校验失败 → 构造 deny 授权 + preDenied call → Phase 2 直接 yield sense_reject，
  //   不进审批（避免"空调用进 smart 审批 → 超时被拒"恶性循环）。schema 缺省（MCP 等入口）跳过校验。
  const entrySchema = senseEntry?.schema
  if (entrySchema) {
    const parsed = entrySchema.safeParse(args)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
        .join('；')
      const deniedAuth: ToolAuthorization = {
        decision: 'deny',
        roleType: 'unassigned',
        policyHash: '',
        findings: [
          {
            code: 'schema.invalid-arguments',
            category: 'unknown',
            severity: 'unknown',
            message: `参数校验失败（${name}）：${issues}。请补充/修正必填参数后重试。`,
          },
        ],
        assessmentHash: '',
      }
      const trigger: SenseTriggerChunk = {
        type: 'sense_end',
        id,
        name,
        arguments: argsJson,
        supervisionLevel: SupervisionLevel.auto,
        security: deniedAuth,
      }
      return {
        trigger,
        call: {
          id,
          name,
          argsJson,
          supervisionLevel: SupervisionLevel.auto,
          authorization: deniedAuth,
          preDenied: true,
        },
      }
    }
  }

  const legacySafe = configuredLevel === SupervisionLevel.smart
    ? isSafeSenseCall(ctx.runtime.sensitivityRules, name, args)
    : undefined
  const roleSecurity = ctx.runtime.roleSecurity ?? compileRoleSecurity(undefined, undefined)
  const workspace = ctx.runtime.acceptance?.workspaceRoot ?? getChatWorkspace(ctx.soul.chatId)
  const authorization = authorizeToolCall({
    security: roleSecurity,
    name,
    args,
    workspace,
    configuredLevel,
    legacySafe,
    // 配置管理核心角色读放行：read_file/search_codebase 绕过 filesystem workspace 校验
    filesystemRead: !ctx.runtime.acceptance && isConfigManager(ctx.runtime.senseTable) ? 'any' : undefined,
    acceptance: ctx.runtime.acceptance,
  })
  const preDenied = authorization.decision === 'deny'
  const effectiveLevel = preDenied ||
    authorization.decision === 'allow' ||
    ctx.runtime.acceptance?.preapproveSafeRequests
    ? SupervisionLevel.auto
    : configuredLevel === SupervisionLevel.manual
      ? SupervisionLevel.manual
      : SupervisionLevel.smart

  let approvalPromise: Promise<{ action: 'accept' | 'reject'; reason?: string }> | undefined

  if (effectiveLevel > SupervisionLevel.auto) {
    // P1-11：审批 Promise 由 core approvalRegistry 管理，resolve/reject 不再随 chunk 传 service。
    //   service ApprovalManager.confirm/abort 调 resolveApproval/rejectApproval 触发本 await。
    // G2：approval_timeout=0（不限时）时 hardTimeoutMs（global.approval_hard_timeout）兜底释放。
    approvalPromise = createApproval(
      id,
      0,
      ctx.global.approval_hard_timeout,
    )
  }

  const preview = effectiveLevel > SupervisionLevel.auto ? approvalPreview(name, argsJson) : undefined
  const trigger: SenseTriggerChunk = {
    type: 'sense_end',
    id,
    name,
    arguments: preview?.arguments ?? argsJson,
    supervisionLevel: effectiveLevel,
    security: authorization,
  }

  return {
    trigger,
    call: {
      id,
      name,
      argsJson,
      supervisionLevel: effectiveLevel,
      approvalPromise,
      authorization,
      approvalSnapshot: preview?.snapshot,
      preDenied,
    },
  }
}

/**
 * 实际执行感官
 */
async function* doExecuteSense(
  ctx: MiddlewareContext,
  name: string,
  argsJson: string,
  id: string,
  authorization: ToolAuthorization,
  approvalSnapshot?: ApprovalSnapshot,
): AsyncGenerator<SenseStartedChunk, {
  content: string
  hash?: string
  rejected?: string
  replaced: Array<{ id: string; content: string; replace: ReplaceInfo; originalContent: string }>
}, unknown> {
  const replaced: Array<{
    id: string
    content: string
    replace: ReplaceInfo
    originalContent: string
  }> = []
  try {
    if (!ctx.runtime) throw new Error('Runtime not configured.')
    if (approvalSnapshot && !approvalSnapshotMatches(approvalSnapshot)) {
      const rejected = '文件已在审批后发生变化；为避免覆盖他人修改，请重新发起并审核新的差异。'
      return { content: rejected, rejected, replaced }
    }
    let args = argsJson ? safeJsonParse(argsJson, {}) : {}
    const senseEntry = ctx.runtime.senseTable.get(name)
    if (!senseEntry) {
      return { content: `没有 "${name}" 这个感官`, replaced }
    }
    // 配置管理核心角色：能力驱动（senseTable 含 config_manage/install_skill），同源用于守卫 + 重授权
    const configManager = isConfigManager(ctx.runtime.senseTable)
    // 路径守卫：拦 .chery/ 直接读写（仅 install_skill 豁免），引导走配置管理核心角色
    // 配置管理核心角色（senseTable 含 install_skill，双重隔离信号）额外豁免 .chery/rule/ 读写：
    // 生成/修改审批规则文件（与基准 base.yaml 深合并）。.chery/ 其余路径仍拦。
    // 读放行（allowConfigRead）：配置管理核心角色 read_file/search_codebase 读 .chery/ 全树放行，
    // 写（write_file/execute_command）仍拦——写走 config_manage/install_skill 结构化通道。
    const guardHit = checkCheryGuard(name, args, {
      allowRuleDir: configManager,
      allowConfigRead: configManager,
    })
    if (guardHit) {
      return { content: guardHit, replaced }
    }

    // PreToolUse hook：执行前拦截/修改 args；handler 抛 ClassifiedError 阻断
    try {
      const preDecision = await dispatch(
        'PreToolUse',
        { name, args, chatId: ctx.soul.chatId },
        { brain: '' },
      )
      if (preDecision?.updatedInput) {
        args = { ...args, ...preDecision.updatedInput }
      }
    } catch (err) {
      if (err instanceof ClassifiedError) {
        return { content: err.userMessage, replaced }
      }
      throw err
    }

    // 审批绑定精确参数与当前角色策略。Hook 改参或审批等待期间策略变化都必须重新发起，
    // 不能拿旧授权执行新动作。
    const liveRole = config.roles?.[authorization.roleType]
    const liveSecurity = compileRoleSecurity(authorization.roleType, liveRole)
    const currentAuthorization = authorizeToolCall({
      security: liveSecurity,
      name,
      args,
      workspace: ctx.runtime.acceptance?.workspaceRoot ?? getChatWorkspace(ctx.soul.chatId),
      configuredLevel: senseEntry.supervisionLevel,
      legacySafe:
        senseEntry.supervisionLevel === SupervisionLevel.smart
          ? isSafeSenseCall(ctx.runtime.sensitivityRules, name, args)
          : undefined,
      // 与 buildSenseTrigger 同源（isConfigManager(ctx.runtime.senseTable)）→ override 一致 → hash 恒等
      filesystemRead: !ctx.runtime.acceptance && configManager ? 'any' : undefined,
      acceptance: ctx.runtime.acceptance,
    })
    if (
      currentAuthorization.policyHash !== authorization.policyHash ||
      currentAuthorization.assessmentHash !== authorization.assessmentHash
    ) {
      const rejected = '安全策略或工具参数已变化，本次旧授权已失效，请重新发起调用'
      return { content: rejected, rejected, replaced }
    }
    if (currentAuthorization.decision === 'deny') {
      const rejected = `角色策略拒绝执行：${currentAuthorization.findings.map((finding) => finding.message).join('；')}`
      return { content: rejected, rejected, replaced }
    }

    // P2-11：chatId 经 SenseRuntimeContext 第 3 参注入（取代 sharedData namespace 临时方案），
    // bash 等需按会话归属的 sense 从 ctx.chatId 读取。
    // T9：yieldTurn 闭包让 sense（spawn_role wait=true）请求 loop 本轮后立即结束（置 soul.yieldTurn）。
    // 真实执行边界：只有审批与所有执行前校验通过后才产生 started；下游先持久化并
    // 发送该事实，generator 下一次推进时才真正调用工具 handler。
    yield {
      type: 'sense_started',
      id,
      name,
      arguments: argsJson,
      startedAt: Date.now(),
    }
    const result = await senseEntry.execute(args, ctx.soul.senseSharedData, {
      chatId: ctx.soul.chatId,
      yieldTurn: () => {
        ctx.soul.yieldTurn = true
      },
      // 透传当前 sense call id（= sense message.id）。spawn_role 等需用此 id 回写 metadata 关联。
      messageId: id,
      security: currentAuthorization,
      workspaceRoot: ctx.runtime.acceptance?.workspaceRoot ?? getChatWorkspace(ctx.soul.chatId),
    })

    // 历史替换逻辑：hash 命中（read_file hash 含 mtime）= 文件未变动，新旧读取内容相同。
    // 旧 sense 内容重复且冗长 → 替换为短说明（告知 AI 已被新读取取代），长内容移至 originalContent 折叠溯源。
    // 文件若被改动 → mtime/size 变 → hash 不同 → 各自独立留存上下文（AI 自行对比，不替换）。
    // 故 hash 保留 mtime：它是"内容是否变动"的关键判据，去掉会让等长改写误判为相同。
    //
    // 黑名单过滤：spawn_role 等"派发标识"型 hash 不参与去重（详见 NON_DEDUPABLE_SENSES 注释）。
    if (result.hash && !NON_DEDUPABLE_SENSES.has(name)) {
      // 历史去重：hash 命中（read_file hash 含 mtime）= 文件未变动，新旧读取内容相同。
      // 旧 sense 内容改写为短说明（长内容折叠 originalContent），由 message_updated effect 落库。
      // 单一写者：in-place 改 originalContent/content/replace 经 ctx.journal.replaceSense。
      const matched = ctx.journal.replaceSense({ matchHash: result.hash, newId: id })
      replaced.push(...matched)
    }

    // 环境变量脱敏：在返回前替换所有 .env 中定义的敏感变量名
    const redactedContent = redactEnvKeys(result.content)

    // PostToolUse hook：执行后审计；handler 抛 ClassifiedError → content 改写为 reason
    try {
      await dispatch(
        'PostToolUse',
        {
          name,
          args,
          result: { content: redactedContent, hash: result.hash, replaced: replaced.length > 0 },
          hash: result.hash,
          chatId: ctx.soul.chatId,
        },
        { brain: '' },
      )
    } catch (err) {
      if (err instanceof ClassifiedError) {
        return { content: err.userMessage, replaced }
      }
      throw err
    }

    return { content: redactedContent, hash: result.hash, replaced }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return { content: `感官执行失败：${errorMsg}`, replaced }
  }
}

export default senseMiddleware
