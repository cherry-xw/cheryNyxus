/**
 * lite 节点色调：与节点树（nyxus graph/nodeSkins）同源统一。
 *
 * 节点树经 accentForTheme(theme, key) 取色（浅色 NODE_ACCENT_LIGHT / 深色 NODE_SKINS，随主题切换）；
 * lite 复用同一来源，把 8 类节点的 accent 以 CSS 变量（--lite-tone-<kind>）绑定到 .lite-view 根元素，
 * 主题切换时随 themeStore 响应式更新——lite 不再维护自创色系，保证与节点树同类型节点色调一致。
 *
 * 工具子类型（exec/read/write/web/dispatch/other）是 lite 特有维度，节点树无此分类，
 * 特征色仍保留在 LiteView.styles.css（仅用于 cluster 按钮边框），不进入本表。
 */
import { computed, type ComputedRef } from 'vue'
import { useThemeStore } from '@/application/public'
import { accentForTheme, type NodeSkinKey } from '@/features/pets/nyxus/graph/nodeSkins'
import type { LiteRunNodeKind } from './executionMonitor'

/** lite 节点类型 → 节点树皮肤键（tool-batch 对应工具执行）。 */
const KIND_TO_SKIN: Readonly<Record<LiteRunNodeKind, NodeSkinKey>> = {
  user: 'user',
  'root-agent': 'root-agent',
  'child-agent': 'child-agent',
  tool: 'tool-batch',
  return: 'return',
  dispatch: 'dispatch',
  spawn: 'spawn',
  system: 'system',
}

export function useLiteNodeTones(): {
  /** 每类节点的 accent 色（跟随主题）。 */
  nodeTones: ComputedRef<Record<LiteRunNodeKind, string>>
  /** CSS 变量映射（--lite-tone-<kind> → 色值），绑定到 .lite-view 根元素。 */
  nodeToneVars: ComputedRef<Record<string, string>>
} {
  const themeStore = useThemeStore()
  const nodeTones = computed<Record<LiteRunNodeKind, string>>(() => {
    const out = {} as Record<LiteRunNodeKind, string>
    for (const kind of Object.keys(KIND_TO_SKIN) as LiteRunNodeKind[]) {
      out[kind] = accentForTheme(themeStore.theme, KIND_TO_SKIN[kind])
    }
    return out
  })
  const nodeToneVars = computed<Record<string, string>>(() => {
    const vars: Record<string, string> = {}
    for (const [kind, accent] of Object.entries(nodeTones.value)) {
      vars[`--lite-tone-${kind}`] = accent
    }
    return vars
  })
  return { nodeTones, nodeToneVars }
}
