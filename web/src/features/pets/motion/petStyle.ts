import type { PetInstance } from '../types/types'

/** tribe → 色相：子 pet name 部落色区分（主 pet name 保持 --pet-color 高亮） */
export function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 360
  }
  return h
}

/**
 * pet 身体 z-index：拖拽最高；否则 hasSpeech 加成（子有气泡主无时子>主，主子都有时主>子）。
 * 气泡独立 z-index（speechZIndex）整体高于身体——因 .pet-wrap 不创建 stacking context。
 *
 * 气泡（含提问/审批）与 pet 共享同一交互层（speechZIndex 区间），不再 400 全局置顶盖住
 * 工作台/对话框。交互窗口归属由「接力棒」机制仲裁：工作台打开时工作台消费（pet 气泡隐藏），
 * 关闭/最小化后交还 pet（pet 层最终兜底）。
 */
export function petBodyZIndex(pet: PetInstance, hovered: boolean): number {
  if (pet.action === 'dragging') return 20
  if (hovered) return 15
  return (pet.speech ? 10 : 0) + (pet.isMaster ? 2 : 1)
}

export function speechZIndex(pet: PetInstance): number {
  if (pet.action === 'dragging') return 120
  return 100 + (pet.isMaster ? 2 : 1)
}
