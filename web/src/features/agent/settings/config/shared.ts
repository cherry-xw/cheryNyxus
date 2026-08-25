/**
 * Settings 面板共享纯函数。依赖 draft/senseTools 的 mutate 操作留在各自 tab 内。
 */
import type { SenseToolInfo } from '@/services/agentApi'
import { DANGEROUS_SENSES } from './constants'

/** entry = "name" 或 "name:level"，取工具名部分。 */
export function toolName(entry: string): string {
  const idx = entry.indexOf(':')
  return idx >= 0 ? entry.slice(0, idx) : entry
}

/** entry = "name" 或 "name:level"，取监管等级部分（空=继承）。 */
export function toolLevel(entry: string): string {
  const idx = entry.indexOf(':')
  return idx >= 0 ? entry.slice(idx + 1) : ''
}

/** entry 工具名命中内置工具则返回其元信息（行内显示 label + description tooltip）。 */
export function matchedTool(entry: string, senseTools: SenseToolInfo[]): SenseToolInfo | undefined {
  return senseTools.find((t) => t.name === toolName(entry))
}

export function isDangerousSense(entry: string): boolean {
  const base = entry.split(':')[0] ?? ''
  return DANGEROUS_SENSES.includes(base)
}

/** 工具文档分节：label=节名（作用/能力/边界/注意），text=节内正文。 */
export interface SenseDocSection {
  label: string
  text: string
}

/**
 * 解析 sense.tools.docs 文档为分节数组：按行切分，识别【X】节头，节内续行并入上一节（防御性）。
 * 无节头的纯文本（如短描述回退）返回 []，调用方回退普通段落展示。
 */
export function parseSenseDoc(doc: string): SenseDocSection[] {
  if (!doc) return []
  const sections: SenseDocSection[] = []
  let cur: SenseDocSection | null = null
  for (const raw of doc.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^【(.+?)】([\s\S]*)$/.exec(line)
    if (m) {
      const text = (m[2] ?? '').trim()
      if (!text) continue // 空节跳过
      cur = { label: m[1] ?? '', text }
      sections.push(cur)
    } else if (cur) {
      cur.text += '\n' + line // 防御：节内出现多行段落时并入上一节
    }
  }
  return sections
}

/**
 * 计算装备 token 总和：values 为空（继承全部模式）则按 options 全量累加。
 * RolesTab.roleTokens / EquipmentPicker.tokens 共用，消除重复估算逻辑。
 * MCP 等无后端 token 数据的资源，调用方在 tokenMap 里填占位值（如 200）。
 */
export function computeSelectionTokens(
  values: string[] | undefined,
  options: string[],
  tokenMap: Record<string, number>,
): number {
  return (values ?? options).reduce((sum, name) => sum + (tokenMap[name] ?? 0), 0)
}
