import { describe, expect, it } from 'vitest'
import {
  BookOpen,
  Forward,
  Globe,
  PenLine,
  Sparkles,
  SquareTerminal,
  UserRound,
  Wrench,
} from 'lucide'
import { clusterNodeIcon } from '../../src/features/lite/clusterIcons'

/**
 * 精简视图 cluster 小按钮的可变形图标映射（morphicons + lucide）。
 * 约定（阶段1确认）：图标类型固定关联工具类型，运行状态与成功/失败由底部状态条表达，
 * 不再把图标统一替换成状态图标。
 */
describe('clusterNodeIcon morph mapping', () => {
  it('maps tool types to their lucide source icon regardless of status', () => {
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'exec' })).toBe(SquareTerminal)
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'read' })).toBe(BookOpen)
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'write' })).toBe(PenLine)
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'web' })).toBe(Globe)
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'dispatch' })).toBe(Forward)
    // 终态不再替换为统一状态图标（工具类型差异保留）
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'exec', status: 'completed' })).toBe(
      SquareTerminal,
    )
    expect(clusterNodeIcon({ kind: 'tool', toolType: 'exec', status: 'failed' })).toBe(
      SquareTerminal,
    )
  })

  it('maps non-tool kinds and falls back to the wrench for unknown tool types', () => {
    expect(clusterNodeIcon({ kind: 'user' })).toBe(UserRound)
    expect(clusterNodeIcon({ kind: 'root-agent' })).toBe(Sparkles)
    expect(clusterNodeIcon({ kind: 'child-agent' })).toBe(Sparkles)
    expect(clusterNodeIcon({ kind: 'tool', toolType: undefined })).toBe(Wrench)
  })
})
