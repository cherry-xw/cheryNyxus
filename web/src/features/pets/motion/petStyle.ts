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
 * CP5 扩展：审批气泡 z-index 单独提升到 APPROVAL_Z_INDEX=400，高于 AgentDialog 300 / HistoryDrawer 280 / FAB 200。
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

/** 审批气泡专属 z-index：固定 400。 */
export const APPROVAL_Z_INDEX = 400
