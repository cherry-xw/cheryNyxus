/**
 * 流程测试 Tier 1：标准对话 S1–S7（中间件级，agentHarness 驱动）。
 *
 * 规约见 [docs/flow-test.md](../../../docs/flow-test.md) §3.A。每场景沿四维断言
 * （事件序列 / 内存消息 / 审批态 / 交互功能）。不走 service/WS/DB，故 canResume/
 * chat_events 等服务层派生留 Tier 2；此处断言其充要条件（末条 assistant 无 senseCalls）。
 *
 * Mock 数据脚本：S1/S2/S3/S4 复用 fixtures/.chery/mock 既有点（content_only/auto_sense/
 * confirm_sense），S5/S6 复用 confirm_sense + per-test 改 config.global 审批超时
 * （AgentSession 存 config.global 引用，live 生效），S7 用 todo_flow.yaml + todo_senses 组。
 * 延迟机制（chunkDelayMs）用 addMockBrain 独立 brain 验证，不污染共享 fixture。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { AgentParkError } from '@/core/middleware/errors.js'
import config from '@/utils/config'
import {
  approve,
  bootstrapForTests,
  createAgent,
  runSend,
  runSendWithApproval,
} from '../../agent/helpers/agentHarness.js'
import {
  collectContent,
  firstConsumed,
  hasDone,
  senseAccepts,
  senseEnds,
  sensePendings,
  senseRejects,
  stagedTypes,
} from '../../agent/helpers/chunkAssert.js'
import { addMockBrain, scriptItem } from '../../agent/helpers/mockScripts.js'

beforeAll(async () => {
  await bootstrapForTests()
})

// ============ S1 纯文本 ============

describe('S1 纯文本（无 sense，loop 单轮）', () => {
  it('consumed → stream.content → content_end → done；末条 assistant 无 senseCalls（ended）', async () => {
    const agent = createAgent({ brain: 'mock_content', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '你好')

    // 事件序列：consumed 起首 → content 流式 → content_end staged → done
    expect(firstConsumed(chunks)).toBeDefined()
    expect(collectContent(chunks)).toContain('纯文本回复')
    expect(stagedTypes(chunks)).toContain('content_end')
    expect(hasDone(chunks)).toBe(true)

    // 无 sense 调用
    expect(senseEnds(chunks)).toHaveLength(0)
    expect(senseAccepts(chunks)).toHaveLength(0)

    // 末条 assistant 无 senseCalls = ended 充要条件（canResume=false 派生）
    const msgs = agent.getMessages()
    const last = msgs[msgs.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.senseCalls ?? []).toHaveLength(0)
  })
})

// ============ S2 auto sense 两轮 ============

describe('S2 auto sense 两轮（loop 续跑）', () => {
  it('sense_end → sense_accept（auto 无审批）→ loop 续 → 末条 assistant 无 senseCalls', async () => {
    const agent = createAgent({ brain: 'mock_auto', senseGroup: 'auto_senses' })
    const chunks = await runSend(agent, '读文件')

    // auto 级无 sense_pending（不经审批）
    expect(sensePendings(chunks)).toHaveLength(0)

    const ends = senseEnds(chunks)
    expect(ends.length).toBeGreaterThanOrEqual(1)
    expect(ends[0]?.name).toBe('read_file')

    // sense_accept.id 与 sense_end.id 同源（= senseCall.id）
    const accepts = senseAccepts(chunks)
    expect(accepts.length).toBeGreaterThanOrEqual(1)
    expect(accepts[0]?.name).toBe('read_file')
    expect(accepts[0]?.id).toBe(ends[0]?.id)

    // loop 续跑（轮2 纯 content）→ done + 末条 assistant 无 senseCalls
    expect(hasDone(chunks)).toBe(true)
    const msgs = agent.getMessages()
    const last = msgs[msgs.length - 1]
    expect(last?.role).toBe('assistant')
    expect(last?.senseCalls ?? []).toHaveLength(0)
  })
})

// ============ S3 confirm accept ============

describe('S3 confirm accept', () => {
  it('sense_pending(confirm) → approve → sense_accept；无 reject', async () => {
    const agent = createAgent({ brain: 'mock_confirm', senseGroup: 'confirm_senses' })
    const chunks = await runSendWithApproval(agent, '写文件', () => 'accept')

    const pending = sensePendings(chunks)
    expect(pending.length).toBeGreaterThanOrEqual(1)
    expect(pending[0]?.supervisionLevel).toBe(1) // confirm
    expect(pending[0]?.senseName).toBe('write_file')

    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1)
    expect(senseRejects(chunks)).toHaveLength(0)
    expect(hasDone(chunks)).toBe(true)
  })
})

// ============ S4 confirm reject ============

describe('S4 confirm reject', () => {
  it('sense_pending → reject reason → sense_reject；reason 透传；loop 续', async () => {
    const agent = createAgent({ brain: 'mock_confirm_reject', senseGroup: 'confirm_senses' })
    const chunks = await runSendWithApproval(agent, '写文件', () => ({
      action: 'reject',
      reason: '危险操作',
    }))

    const rejects = senseRejects(chunks)
    expect(rejects.length).toBeGreaterThanOrEqual(1)
    expect(rejects[0]?.reason).toContain('危险操作')

    // reject 路径：loop 继续（非 paused）→ done
    expect(hasDone(chunks)).toBe(true)
  })
})

// ============ S5 审批超时自动拒（G2 用户超时分支） ============

describe('S5 审批超时自动拒（approval_timeout>0）', () => {
  let saved: number | undefined
  beforeEach(() => {
    saved = config.global.approval_timeout
  })
  afterEach(() => {
    config.global.approval_timeout = saved
  })

  it('不审批 → 用户超时 resolve-as-reject → sense_reject(reason 含超时) → loop 续 → done', async () => {
    config.global.approval_timeout = 80 // 短超时（真实 timer，非 fake）
    const agent = createAgent({ brain: 'mock_confirm', senseGroup: 'confirm_senses' })

    // 业务超时由 service ApprovalManager 驱动；Tier 1 用同样的 reject 决策模拟该边界。
    const chunks = await runSendWithApproval(agent, '写文件', (pending) => {
      setTimeout(() => approve(pending.approvalId, 'reject', '审批超时，工具未执行'), 80)
      return undefined
    })

    const rejects = senseRejects(chunks)
    expect(rejects.length).toBeGreaterThanOrEqual(1)
    expect(rejects[0]?.reason).toContain('超时')
    // reject 路径（非 paused）：loop 续 → done
    expect(hasDone(chunks)).toBe(true)
  })
})

// ============ S6 不限时 hard-park（G2 改造D 验收） ============

describe('S6 不限时 hard-park（approval_timeout=0 + hard_timeout）', () => {
  let savedT: number | undefined
  let savedH: number | undefined
  beforeEach(() => {
    savedT = config.global.approval_timeout
    savedH = config.global.approval_hard_timeout
  })
  afterEach(() => {
    config.global.approval_timeout = savedT
    config.global.approval_hard_timeout = savedH
  })

  it('不审批 → hard timer → AgentParkError → generator throw（无 done = paused 可续）', async () => {
    config.global.approval_timeout = 0 // 不限时 → 走 hard-timeout 分支
    config.global.approval_hard_timeout = 80 // 短 hard 上限
    const agent = createAgent({ brain: 'mock_confirm', senseGroup: 'confirm_senses' })

    // 手动 for await：不审批（无 decide），捕获 hard-park throw
    const out: MiddlewareChunk[] = []
    let thrown: unknown
    try {
      for await (const c of agent.run('写文件')) out.push(c)
    } catch (e) {
      thrown = e
    }

    // hard-timeout = park（AgentParkError，归 paused 可续），非用户拒绝（resolve-as-reject）
    expect(thrown).toBeInstanceOf(AgentParkError)
    // generator throw → 无 done（paused，非 ended）；canResume=true 派生属 Tier 2 验证
    expect(hasDone(out)).toBe(false)
    expect(sensePendings(out).length).toBeGreaterThanOrEqual(1)
  })
})

// ============ S7 todo list ============

describe('S7 todo list（update_todo:auto → sense_end.arguments.todos 结构化）', () => {
  it('update_todo 自动执行 → sense_end.arguments 携带结构化 todos（currentTodo 派生源）', async () => {
    const agent = createAgent({ brain: 'mock_todo', senseGroup: 'todo_senses' })
    const chunks = await runSend(agent, '规划任务')

    const todoEnds = senseEnds(chunks).filter((e) => e.name === 'update_todo')
    expect(todoEnds.length).toBeGreaterThanOrEqual(1)

    // arguments 是结构化 todos JSON（currentState.currentTodo 的派生源；G8 currentState.test.ts 已验派生）
    const args = JSON.parse(todoEnds[0]!.arguments) as { todos: Array<Record<string, unknown>> }
    expect(args.todos).toHaveLength(3)
    expect(args.todos[0]).toMatchObject({ content: '分析需求', status: 'completed' })
    expect(args.todos[1]).toMatchObject({
      content: '实现功能',
      status: 'in_progress',
      activeForm: '编码中',
    })
    expect(hasDone(chunks)).toBe(true)
  })
})

// ============ mock 延迟机制（chunkDelayMs） ============

describe('mock 延迟机制（chunkDelayMs：流式窗口可测）', () => {
  it('chunkDelayMs 使流式 delta 间确有耗时', async () => {
    // 独立 brain 注入延迟，不污染共享 fixture
    const brain = addMockBrain('flow-delay', {
      repeat: 'last',
      script: [scriptItem({ thinking: '思考', content: '回复' })],
    })
    const mock = config.llm.brain[brain]?.mock
    expect(mock).toBeDefined()
    mock!.chunkDelayMs = 50 // thinking + content 两 delta，各前 sleep 50ms

    try {
      const agent = createAgent({ brain, senseGroup: 'auto_senses' })
      const start = Date.now()
      await runSend(agent, '回复')
      const elapsed = Date.now() - start
      // 两 delta 各 sleep 50ms → ≥ ~100ms（留容差）
      expect(elapsed).toBeGreaterThanOrEqual(90)
    } finally {
      mock!.chunkDelayMs = 0
    }
  })
})
