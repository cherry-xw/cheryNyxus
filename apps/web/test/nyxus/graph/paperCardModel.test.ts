import { describe, expect, it } from 'vitest'
import type { SenseToolInfo, TimelineNode } from '../../../src/services/agentApi'
import type { ExecutionNode } from '../../../src/features/pets/nyxus/graph/executionGraph'
import { buildPaperGameCard } from '../../../src/features/pets/nyxus/paper/paperCardModel'

function node(overrides: Partial<ExecutionNode> = {}): ExecutionNode {
  return {
    id: 'node-1',
    kind: 'message',
    rootChatId: 'root',
    sourceChatId: 'root',
    actor: { kind: 'agent', chatId: 'root', roleType: 'Scholar' },
    direction: 'agent-to-user',
    content: 'A complete response for the adventurer.',
    thinking: 'A hidden chain of thought.',
    createdAt: 1_700_000_000_000,
    status: 'completed',
    main: true,
    orderSlot: 'persistent',
    orderKey: 1,
    activeRuns: [],
    ...overrides,
  }
}

function sourceFact(overrides: Partial<TimelineNode> = {}): TimelineNode {
  return {
    id: 'fact-1',
    rootChatId: 'root',
    sourceChatId: 'root',
    kind: 'message',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: 'response',
    orderKey: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    status: 'committed',
    ...overrides,
  }
}

const senseTools: SenseToolInfo[] = [
  { name: 'search_codebase', label: '搜索代码库', description: '', icon: '🔍' },
  { name: 'read_file', label: '读取文件', description: '', icon: '📄' },
]

function card(entry: ExecutionNode) {
  return buildPaperGameCard(entry, {
    title: 'Card title',
    index: 3,
    total: 12,
    relatedEdges: [],
    senseTools,
  })
}

describe('paper game card model', () => {
  it('maps user and root-agent messages to distinct role cards', () => {
    const user = card(
      node({
        actor: { kind: 'user', actorId: 'human', displayName: 'Hero' },
        direction: 'user-to-agent',
        thinking: undefined,
      }),
    )
    const llm = card(node())

    expect(user).toMatchObject({ kind: 'adventurer', icon: 'adventurer', kicker: '冒险者记录' })
    expect(llm).toMatchObject({ kind: 'arcanist', icon: 'magic', kicker: '秘法学者' })
    expect(llm.details.map((detail) => detail.kind)).toEqual(['content', 'thinking'])
  })

  it('maps child-agent messages to companion cards', () => {
    const result = card(
      node({
        sourceChatId: 'child',
        actor: { kind: 'agent', chatId: 'child', roleType: 'Scout' },
      }),
    )

    expect(result).toMatchObject({ kind: 'companion', icon: 'companion', kicker: '伙伴角色卡' })
  })

  it('builds a skill card with selectable calls and argument/result intelligence blocks', () => {
    const result = card(
      node({
        kind: 'tool-batch',
        actor: { kind: 'tool', toolName: 'search_codebase' },
        content: 'Search the realm',
        thinking: 'Choose a narrow query.',
        sourceFact: sourceFact({
          kind: 'tool-batch',
          actor: { kind: 'tool', toolName: 'search_codebase' },
          toolCalls: [
            {
              callId: 'call-search',
              index: 0,
              name: 'search_codebase',
              arguments: '{"query":"paper"}',
              result: 'Found 4 files',
              status: 'completed',
            },
            {
              callId: 'call-read',
              index: 1,
              name: 'read_file',
              arguments: '{"path":"paper.ts"}',
              status: 'pending',
            },
          ],
        }),
      }),
    )

    expect(result).toMatchObject({ kind: 'skill', icon: 'gear', selectedSkillId: 'call-read' })
    expect(result.skills).toHaveLength(2)
    expect(result.skills.map((skill) => skill.label)).toEqual(['搜索代码库', '读取文件'])
    expect(result.title).toBe('文件读取')
    expect(result.details.map((detail) => detail.kind)).toEqual([
      'content',
      'thinking',
      'arguments',
    ])
  })

  it('preserves an exact external tool name when no display metadata exists', () => {
    const result = card(
      node({
        kind: 'tool-batch',
        actor: { kind: 'tool', toolName: 'mcp__custom_tool' },
        sourceFact: sourceFact({
          kind: 'tool-batch',
          actor: { kind: 'tool', toolName: 'mcp__custom_tool' },
          toolCalls: [
            {
              callId: 'call-external',
              index: 0,
              name: 'mcp__custom_tool',
              arguments: '{}',
              status: 'completed',
            },
          ],
        }),
      }),
    )

    expect(result.title).toBe('mcp__custom_tool')
    expect(result.skills[0]?.label).toBe('mcp__custom_tool')
  })

  it('keeps a multi-call fold member as one ordered process stage', () => {
    const memberNode = node({
      id: 'batch-member',
      kind: 'tool-batch',
      sourceFact: sourceFact({
        id: 'batch-fact',
        kind: 'tool-batch',
        toolCalls: [
          { callId: 'read', index: 1, name: 'read_file', arguments: '{}', status: 'completed' },
          {
            callId: 'search',
            index: 0,
            name: 'search_codebase',
            arguments: '{}',
            status: 'completed',
          },
        ],
      }),
    })
    const fold = node({
      id: 'fold',
      kind: 'fold',
      fold: {
        firstNodeId: memberNode.id,
        lastNodeId: memberNode.id,
        members: [{ id: 'stage', displayNode: memberNode, nodes: [memberNode] }],
        projectionNodes: [memberNode],
      },
    })
    const result = buildPaperGameCard(memberNode, {
      title: '过程组',
      index: 0,
      total: 1,
      foldNode: fold,
      senseTools,
    })

    expect(result.processStages).toHaveLength(1)
    expect(result.processStages?.[0]?.calls.map((call) => call.id)).toEqual(['search', 'read'])
    expect(result.processStages?.[0]?.calls.map((call) => call.label)).toEqual([
      '搜索代码库',
      '读取文件',
    ])

    const stage = result.processStages![0]!
    const directCard = buildPaperGameCard(stage.node, stage.cardOptions)
    const readCard = buildPaperGameCard(stage.node, {
      ...stage.cardOptions,
      selectedCallId: 'read',
    })
    expect(directCard.title).toBe('代码搜索')
    expect(readCard.title).toBe('文件读取')
    expect(stage).not.toHaveProperty('nodeCard')
    expect(stage).not.toHaveProperty('nodeCardsByCallId')
  })

  it('renders update_todo arguments as a todo list instead of a nested field tree', () => {
    const result = card(
      node({
        kind: 'tool-batch',
        actor: { kind: 'tool', toolName: 'update_todo' },
        sourceFact: sourceFact({
          kind: 'tool-batch',
          actor: { kind: 'tool', toolName: 'update_todo' },
          toolCalls: [
            {
              callId: 'call-todo',
              index: 0,
              name: 'update_todo',
              arguments:
                '{"todos":[{"content":"准备材料","status":"completed"},{"content":"起草结论","status":"in_progress"},{"content":"校验发布","status":"pending"}]}',
              result: '任务列表已更新 (3 项):\n- [x] 准备材料\n- [ ] 起草结论\n- [ ] 校验发布',
              status: 'completed',
            },
          ],
        }),
      }),
    )

    const argumentsDetail = result.details.find((detail) => detail.kind === 'arguments')
    expect(argumentsDetail?.todos).toEqual([
      { content: '准备材料', status: 'completed' },
      { content: '起草结论', status: 'in_progress' },
      { content: '校验发布', status: 'pending' },
    ])
    expect(argumentsDetail?.fields).toBeUndefined()
    // 结果文本不单列（对话页同款：待办列表已承载状态，避免重复）。
    expect(result.details.find((detail) => detail.kind === 'result')).toBeUndefined()
  })

  it('falls back to normal field rendering when update_todo args are not a valid todo list', () => {
    const result = card(
      node({
        kind: 'tool-batch',
        actor: { kind: 'tool', toolName: 'update_todo' },
        sourceFact: sourceFact({
          kind: 'tool-batch',
          actor: { kind: 'tool', toolName: 'update_todo' },
          toolCalls: [
            {
              callId: 'call-todo-bad',
              index: 0,
              name: 'update_todo',
              arguments: '{"todos":"not-an-array"}',
              status: 'completed',
            },
          ],
        }),
      }),
    )

    const argumentsDetail = result.details.find((detail) => detail.kind === 'arguments')
    expect(argumentsDetail?.todos).toBeUndefined()
    expect(argumentsDetail?.fields?.length).toBeGreaterThan(0)
  })

  it('maps returns, delegation, system, and folds to their game panels', () => {
    expect(card(node({ kind: 'return' })).kind).toBe('treasure')
    expect(card(node({ kind: 'dispatch' })).kind).toBe('quest')
    expect(card(node({ kind: 'system', actor: { kind: 'system' } })).kind).toBe('notice')
    expect(card(node({ kind: 'fold' })).kind).toBe('journal')
  })

  it('flags a fold card whose hidden members contain an error message', () => {
    const errorMember = node({
      id: 'hidden-error',
      sourceFact: sourceFact({
        id: 'hidden-error-fact',
        termination: { actor: 'agent', code: 'error', at: 1_700_000_000_000 },
      }),
    })
    const fold = node({
      id: 'fold',
      kind: 'fold',
      fold: {
        firstNodeId: errorMember.id,
        lastNodeId: errorMember.id,
        members: [{ id: 'stage', displayNode: errorMember, nodes: [errorMember] }],
        projectionNodes: [errorMember],
      },
    })
    const result = buildPaperGameCard(fold, {
      title: '过程组',
      index: 0,
      total: 1,
      foldNode: fold,
      senseTools,
    })

    expect(result.containsHiddenError).toBe(true)

    const plain = card(node())
    expect(plain.containsHiddenError).toBeUndefined()
  })
})
