/**
 * 适配器展示元数据：icon + 中文优先 label。
 *  - value 与 PROVIDERS[i] 对应，是 brain.cfg.provider 写入/读取的枚举值。
 *  - label 命名约定：**中文在前，英文/协议名在后**。有自然中文品牌名时拼接（如「智谱 BigModel」、
 *    「深度求索 DeepSeek」），无自然中文品牌名时单独保留英文名（OpenAI / Ollama / Anthropic）。
 *  - icon 优先用 `web/src/assets/ai-icons/` 的 PNG；该目录下 mock 等无品牌素材时退到 emoji。
 *  - 模板渲染同名时省略 value（如「openai / OpenAI」折叠成「OpenAI」）。
 *
 * 拆到独立文件而非塞 constants.ts，是因为 PNG 资源与「品牌名 label」语义归属各组件目录：
 * BrainsTab（资源轨）与 BrainCard（适配器下拉）共用一份元数据，避免重复维护。
 */
import type { PROVIDERS } from '../../config/constants'
import openaiIcon from '@/assets/ai-icons/openai.png'
import ollamaIcon from '@/assets/ai-icons/ollama.png'
import anthropicIcon from '@/assets/ai-icons/anthropic.png'
import zhipuIcon from '@/assets/ai-icons/zhipu.png'
import deepseekIcon from '@/assets/ai-icons/deepseek.png'

export type ProviderId = (typeof PROVIDERS)[number]

export interface ProviderMeta {
  value: ProviderId
  label: string
  /** PNG 资源模块 URL（vite 构建注入），或 emoji 字符（mock 兜底）。 */
  icon: string
}

export const PROVIDER_META: Record<ProviderId, ProviderMeta> = {
  // 无自然中文品牌名 → 仅英文名
  openai: { value: 'openai', label: 'OpenAI', icon: openaiIcon },
  ollama: { value: 'ollama', label: 'Ollama', icon: ollamaIcon },
  anthropic: { value: 'anthropic', label: 'Anthropic', icon: anthropicIcon },
  // mock 是协议语义，无品牌。中文描述（离线模拟）置前，英文协议名后缀
  mock: { value: 'mock', label: '离线 Mock', icon: '🎭' },
  // 智谱 = BigModel 协议名 → 中文品牌在前，英文协议名后缀
  bigmodel: { value: 'bigmodel', label: '智谱', icon: zhipuIcon },
  // 深度求索 = DeepSeek 品牌名 → 中文品牌在前，英文品牌名后缀
  deepseek: { value: 'deepseek', label: '深度求索', icon: deepseekIcon },
}

/** 模板里判断同名折叠：label 与 value 实质指向同义 → 仅渲染 label。
 * 仅当 label 不含中文/空格/协议名（即与 value 一一对应的简写）时折叠。 */
export function isProviderLabelRedundant(value: ProviderId): boolean {
  const label = PROVIDER_META[value].label.trim().toLowerCase()
  return label === value
}

/** icon 是否 PNG/资源路径（vite 注入的 module URL 以 `/` 或 `data:` 开头）；否则按 emoji 文本渲染。 */
export function isProviderIconAsset(value: ProviderId): boolean {
  const icon = PROVIDER_META[value].icon
  return icon.startsWith('/') || icon.startsWith('data:')
}
