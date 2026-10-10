import { describe, expect, it } from 'vitest'
import {
  BookOpen,
  Forward,
  Globe,
  MessageCircleQuestionMark,
  PenLine,
  SquareTerminal,
  Wrench,
} from 'lucide'
import { toolCallIcon, THINKING_ICONS } from '../../src/features/lite/clusterIcons'
import { Brain, BrainCog } from 'lucide'

/**
 * 精简视图 cluster 行的图标映射（morphicons + lucide）。
 * 约定：图标类型固定关联工具类型（按工具名分类），运行状态与成功/失败由 icon 右上角
 * 状态点表达（v3.1 起，见 LiteView.styles.css `.lite-tool-call-dot`），不再把图标统一
 * 替换成状态图标；提问工具展示问号气泡，不落回通用扳手。
 */
describe('toolCallIcon morph mapping', () => {
  it('maps tool names to their lucide source icon by classified tool type', () => {
    expect(toolCallIcon('exec_command')).toBe(SquareTerminal)
    expect(toolCallIcon('read_file')).toBe(BookOpen)
    expect(toolCallIcon('write_file')).toBe(PenLine)
    expect(toolCallIcon('web_search')).toBe(Globe)
    expect(toolCallIcon('dispatch_agent')).toBe(Forward)
  })

  it('keeps the ask-user-question icon distinct instead of the generic wrench', () => {
    expect(toolCallIcon('ask_user_question')).toBe(MessageCircleQuestionMark)
  })

  it('falls back to the wrench for unknown tool names', () => {
    expect(toolCallIcon('totally_unknown_tool')).toBe(Wrench)
  })

  it('exposes the thinking marker icons for idle/active states', () => {
    expect(THINKING_ICONS.idle).toBe(Brain)
    expect(THINKING_ICONS.active).toBe(BrainCog)
  })
})
