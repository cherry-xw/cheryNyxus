import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { splitCommandPrompt } from '../../../src/features/agent/composables/commands'
import type {
  ExecutionNode,
  ExecutionNodeKind,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  NODE_SKINS,
  canPinNodeDetail,
  hasNodeHoverDetail,
} from '../../../src/features/pets/nyxus/graph/nodeSkins'

const NODE_KINDS: ExecutionNodeKind[] = [
  'start',
  'message',
  'tool-batch',
  'return',
  'dispatch',
  'system',
  'spawn',
  'fold',
  'input',
  'unknown',
]

function node(kind: ExecutionNodeKind): ExecutionNode {
  return {
    id: `${kind}:test`,
    kind,
    rootChatId: 'root',
    sourceChatId: 'root',
    actor: { kind: 'system' },
    direction: 'internal',
    content: kind,
    createdAt: 0,
    status: 'transient',
    main: true,
    orderSlot: kind === 'start' ? 'start' : 'transient',
    orderKey: null,
    activeRuns: [],
  }
}

describe('execution node hover details', () => {
  it('covers every interactive node kind (start is decorative, excluded)', () => {
    const interactiveKinds = NODE_KINDS.filter((kind) => kind !== 'start')
    expect(interactiveKinds.every((kind) => hasNodeHoverDetail(node(kind)))).toBe(true)
    expect(hasNodeHoverDetail(node('start'))).toBe(false)
  })

  it('does not broaden the existing click-to-pin interaction', () => {
    expect(canPinNodeDetail(node('message'))).toBe(false)
    expect(canPinNodeDetail(node('start'))).toBe(false)
    expect(canPinNodeDetail(node('tool-batch'))).toBe(true)
    expect(canPinNodeDetail(node('fold'))).toBe(true)
  })

  it('uses user-facing Chinese names instead of internal English node kinds', () => {
    expect(NODE_SKINS['root-agent'].label).toBe('Cherry Nyxus')
    expect(NODE_SKINS['child-agent'].label).toBe('协作节点')
    expect(NODE_SKINS.fold.label).toBe('过程组')
    expect(NODE_SKINS['tool-batch'].label).toBe('工具执行')
    expect(Object.values(NODE_SKINS).map((skin) => skin.label)).not.toContain('Fold')
  })

  it('keeps chrome fixed and only renders descriptions returned in node data', async () => {
    const source = await readFile(
      resolve('src/features/pets/nyxus/components/ExecutionNodePopover.vue'),
      'utf8',
    )

    expect(source).toContain('class="popover-chrome"')
    expect(source).toContain('class="popover-body"')
    expect(source).toContain('v-if="actualDescription"')
    expect(source).not.toContain('toolMeta.value?.description')
    expect(source).not.toContain('正在处理这一步所需的工具操作')
    expect(source).not.toContain('batchMessageNode')
    expect(source).toContain('props.node.thinking?.trim()')
    // Bug 2 布局（询问场景）：标题 → batch-lead(思考/正文) → question-tabs(指示器) → 选项区
    // 非询问场景的 header tool-tabs 位于 batch-lead 之前（点击切换工具详情），二者互斥。
    expect(source.indexOf('class="question-title-row"')).toBeLessThan(
      source.indexOf('v-if="batch" class="batch-lead"'),
    )
    expect(source.indexOf('v-if="batch" class="batch-lead"')).toBeLessThan(
      source.indexOf('class="tool-tabs question-tabs"'),
    )
    expect(source.indexOf('class="tool-tabs question-tabs"')).toBeLessThan(
      source.indexOf(':show-heading="false"'),
    )
    expect(source).toContain('v-if="batch" class="batch-lead"')
    expect(source).toContain('v-if="batch && toolBatchUsesTabs(batch.calls)"')
  })

  it('renders every user command token with the dedicated node-tree treatment', async () => {
    const source = await readFile(
      resolve('src/features/pets/nyxus/components/ExecutionNodePopover.vue'),
      'utf8',
    )

    expect(source).toContain("splitCommandPrompt(nodeContent.value || '')")
    expect(source).toContain("segment.type === 'command'")
    expect(source).toContain('class="node-command-token"')
    expect(source).toContain('class="node-command-token-kind"')
    expect(source).toContain('aria-hidden="true">指令</span>')
    expect(source).not.toContain('aria-hidden="true">CMD</span>')
    expect(source).toContain('{{ segment.value }}')

    expect(splitCommandPrompt('[[command:/compact]]\n[[command:/review]] 检查一下')).toEqual([
      { type: 'command', value: '/compact' },
      { type: 'text', value: '\n' },
      { type: 'command', value: '/review' },
      { type: 'text', value: ' 检查一下' },
    ])
  })

  it('localizes dispatch details, keeps tab status in content and exposes copy actions', async () => {
    const source = await readFile(
      resolve('src/features/pets/nyxus/components/ExecutionNodePopover.vue'),
      'utf8',
    )

    expect(source).toContain("barrier: '全部完成后继续'")
    expect(source).toContain('<small class="detail-label">派遣角色</small>')
    expect(source).toContain('<small class="detail-label">派遣信息</small>')
    expect(source).toContain('<small class="detail-label">派遣提示词</small>')
    expect(source).not.toContain('class="tool-tab-status"')
    expect(source).toContain('class="tool-tab-icon"')
    expect(source).toContain('class="single-tool-status"')
    expect(source).not.toContain('SenseCallRenderer')
    expect(source).not.toContain('class="popover-tool"')
    expect(source).toContain('class="file-detail"')
    expect(source).toContain('class="file-content-block detail-field"')
    expect(source).toContain('{{ readFilePreview }}')
    expect(source).toContain('class="question-detail"')
    expect(source).toContain('class="question-option"')
    expect(source).toContain('class="question-other detail-field"')
    expect(source).toContain('v-if="!batch" class="status-pill"')
    expect(source).toContain('class="field-copy-button"')
    expect(source).toContain('class="detail-label"')
    expect(source).toContain('class="detail-value is-copyable')
    expect(source).not.toContain('class="field-heading"')
    expect(source).toContain('display: inline-flex')
    expect(source).toContain('align-items: center')
    expect(source).toContain('white-space: pre-wrap')
  })

  it('renders code search and skill loading with dedicated native detail sections', async () => {
    const source = await readFile(
      resolve('src/features/pets/nyxus/components/ExecutionNodePopover.vue'),
      'utf8',
    )

    expect(source).toContain('v-else-if="isSearchTool" class="search-detail"')
    expect(source).toContain('<small class="detail-label">搜索内容</small>')
    expect(source).toContain('<small class="detail-label">搜索范围</small>')
    expect(source).toContain('<small class="detail-label">搜索配置</small>')
    expect(source).toContain('class="search-result-list"')
    expect(source).toContain('class="search-result-location"')
    expect(source).toContain("copyField('search-result', selectedCall.result)")

    expect(source).toContain('v-else-if="isSkillTool" class="skill-detail"')
    expect(source).toContain('<small class="detail-label">技能名称</small>')
    expect(source).toContain('技能指令 · {{ skillResult.lineCount }} 行')
    expect(source).toContain('renderMarkdown(skillResult.content)')
    expect(source).toContain("copyField('skill-content', skillResult.content)")
    expect(source).toContain('未找到技能“${missing[1]}”。')
    expect(source).not.toContain('<SkillRenderer')
  })

  it('limits continuous CRT motion to the small live status dot', async () => {
    const source = await readFile(
      resolve('src/features/pets/nyxus/components/AnchoredRunCrt.vue'),
      'utf8',
    )

    expect(source).toContain('animation: live-dot-pulse 1.4s linear infinite')
    expect(source).not.toContain('animation: crt-scan')
    expect(source).toContain("{ id: 'output', label: '正文' }")
    expect(source).toContain("label: '思考'")
  })
})
