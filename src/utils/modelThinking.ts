/**
 * 模型 → 思考档位映射（显示词 + 请求参数片段）。
 *
 * UI 渲染层显示「显示词」（off/on/low/…/自定义词），请求层使用各显示词显式声明的
 * 「请求参数片段」（如 MiniMax 的 `thinking:{type:disabled}`、OpenAI 系的 `reasoning_effort:high`）。
 * 本模块：
 *   1. 启动期一次性加载 `.chery/model-thinking.yaml`，in-memory 缓存。
 *   2. `resolveThinkingLevels(model)`：按 model 查显示词数组（RPC utils.thinkingLevels → 前端旋钮）。
 *   3. `resolveThinkingParams(model, display)`：显示词 → 请求参数片段（chat middleware 统一翻译点）。
 *   4. `resolveThinkingLevelsBatch(models)`：批量查询显示词。
 *
 * YAML 格式：`thinking` 为 `{display, params}` 数组——**数组顺序 = UI 弱→强顺序**；
 * `params` 为请求体片段，空对象 = 不发任何思考参数。旧版纯字符串数组格式不兼容（按非法条目丢弃）。
 *
 * 配置文件不存在或解析失败 → 返回空配置，显示词全量走兜底 `["off", "on"]`（片段均为空）。
 *
 * 详见 [../../../docs/utils/README.md](../../../docs/utils/README.md) 「modelThinking.ts」。
 */
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { ThinkingLevel } from '@/core/llm/adapter'

/** 单档位规格：display 为 UI 显示词；params 为请求参数片段（空对象 = 不发参）。 */
export interface ThinkingLevelSpec {
  display: string
  params: Record<string, unknown>
}

/** 兜底显示词：未配置 / 未命中 / 解析失败 时返回（片段均为空 = 不发参）。 */
const FALLBACK_DISPLAYS: readonly ThinkingLevel[] = ['off', 'on']

/** 兜底条目：显示词同 FALLBACK_DISPLAYS，片段均为空。 */
const FALLBACK_ENTRY: ModelThinkingEntry = {
  aliases: ['*'],
  thinking: [
    { display: 'off', params: {} },
    { display: 'on', params: {} },
  ],
}

/** 配置条目（YAML 单条）。aliases 含若干模型名（含通配 `"*"`）；thinking 为档位规格数组（顺序 = UI 序）。 */
export interface ModelThinkingEntry {
  aliases: string[]
  thinking: ThinkingLevelSpec[]
}

/** 加载后的内存模型（已兜底）。 */
export interface ModelThinkingConfig {
  entries: ModelThinkingEntry[]
}

let cached: ModelThinkingConfig | undefined

/** 获取 .chery 目录（与 config.ts 一致：CHERY_DIR ?? cwd）。 */
function resolveCheryDir(): string {
  return process.env.CHERY_DIR || process.cwd()
}

/** 单条档位规格解析：{display: 非空字符串, params?: object|null} → ThinkingLevelSpec；非法返回 undefined。 */
function parseThinkingSpec(item: unknown): ThinkingLevelSpec | undefined {
  if (typeof item !== 'object' || item === null) return undefined
  const raw = item as { display?: unknown; params?: unknown }
  if (typeof raw.display !== 'string' || raw.display.trim() === '') return undefined
  // params 缺省 / null / 非对象（含数组）→ 空片段（不发参）；仅接受 plain object
  if (raw.params === undefined || raw.params === null) {
    return { display: raw.display, params: {} }
  }
  if (typeof raw.params !== 'object' || Array.isArray(raw.params)) return undefined
  return { display: raw.display, params: raw.params as Record<string, unknown> }
}

/**
 * 加载 `.chery/model-thinking.yaml`。幂等：首次加载后 in-memory 缓存。
 * 配置文件不存在 / 解析失败 / aliases 或 thinking 为空 → 返回空 entries（全量走兜底）。
 * 非法条目（旧版字符串数组格式、缺 display、params 非对象）整条丢弃，不抛错（软依赖）。
 */
export function loadModelThinking(): ModelThinkingConfig {
  if (cached) return cached
  const configPath = path.join(resolveCheryDir(), '.chery', 'model-thinking.yaml')
  if (!fs.existsSync(configPath)) {
    cached = { entries: [] }
    return cached
  }
  try {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as {
      models?: Array<{ aliases?: unknown; thinking?: unknown }>
    } | null
    const entries: ModelThinkingEntry[] = []
    for (const item of raw?.models ?? []) {
      const aliases = Array.isArray(item.aliases)
        ? item.aliases.filter((a): a is string => typeof a === 'string')
        : []
      const thinking = Array.isArray(item.thinking)
        ? item.thinking
            .map(parseThinkingSpec)
            .filter((s): s is ThinkingLevelSpec => s !== undefined)
        : []
      if (aliases.length > 0 && thinking.length > 0) {
        entries.push({ aliases, thinking })
      }
    }
    cached = { entries }
    return cached
  } catch {
    // YAML 解析失败：兜底空配置，全量返回 ["off", "on"]
    cached = { entries: [] }
    return cached
  }
}

/**
 * 按 model 名查找配置条目（按 YAML 文件原顺序）。
 * 匹配顺序：精确（aliases 含完整 model） → 最长前缀（aliases 中作为 model 前缀）→ 通配 `*` → undefined。
 */
function findThinkingEntry(model: string): ModelThinkingEntry | undefined {
  const cfg = loadModelThinking()

  // 1. 精确匹配
  for (const e of cfg.entries) {
    if (e.aliases.includes(model)) {
      return e
    }
  }

  // 2. 最长前缀匹配
  let bestLen = -1
  let best: ModelThinkingEntry | undefined
  for (const e of cfg.entries) {
    if (e.aliases.includes('*')) continue
    for (const alias of e.aliases) {
      if (model.startsWith(alias) && alias.length > bestLen) {
        best = e
        bestLen = alias.length
      }
    }
  }
  if (best) return best

  // 3. 通配 `*` 兜底
  for (const e of cfg.entries) {
    if (e.aliases.includes('*')) {
      return e
    }
  }

  // 4. 配置缺失 / 未命中
  return undefined
}

/**
 * 按 model 名查显示词数组（按 YAML 文件原顺序原样返回）。
 * 匹配顺序：精确 → 最长前缀 → 通配 `*` → 兜底 ["off","on"]。
 */
export function resolveThinkingLevels(model: string): readonly ThinkingLevel[] {
  if (!model) return FALLBACK_DISPLAYS
  return findThinkingEntry(model)?.thinking.map((s) => s.display) ?? FALLBACK_DISPLAYS
}

/**
 * 显示词 → 请求参数片段（chat middleware 统一翻译点）。
 * 空片段 / 未命中条目 / 未命中显示词 / 文件缺失 → undefined（provider 不追加任何思考参数）。
 */
export function resolveThinkingParams(
  model: string,
  display: string | undefined,
): Record<string, unknown> | undefined {
  if (!display) return undefined
  const entry = model ? findThinkingEntry(model) : undefined
  const spec = (entry ?? FALLBACK_ENTRY).thinking.find((s) => s.display === display)
  if (!spec || Object.keys(spec.params).length === 0) return undefined
  return spec.params
}

/**
 * 批量查询显示词（RPC utils.thinkingLevels 用）。
 * 返回 `Record<model, ThinkingLevel[]>`，model 不为空字符串（空串跳过）。
 */
export function resolveThinkingLevelsBatch(
  models: string[],
): Record<string, readonly ThinkingLevel[]> {
  const out: Record<string, readonly ThinkingLevel[]> = {}
  for (const m of models) {
    if (typeof m !== 'string' || m.length === 0) continue
    out[m] = resolveThinkingLevels(m)
  }
  return out
}
