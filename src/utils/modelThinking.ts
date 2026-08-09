/**
 * 模型 → 思考强度档位映射。
 *
 * 不同模型支持的 ThinkingLevel 子集不同（OpenAI o1 系支持 reasoning_effort 全 4 档，
 * ollama / 部分长上下文模型可能只支持开关两档）。本模块：
 *   1. 启动期一次性加载 `.chery/model-thinking.yaml`，in-memory 缓存。
 *   2. 提供 `resolveThinkingLevels(model)`：按 model 名查档位（精确 > 最长前缀 > 通配 `*` > 兜底）。
 *   3. 提供 `resolveThinkingLevelsBatch(models)`：批量查询（RPC utils.thinkingLevels 用）。
 *
 * YAML 格式：`thinking: [...]` 数组——**原样返回文件中的单词，按 YAML 顺序**。
 * 不校验、不过滤、不映射 canonical 序列：`[off, on, high, max]` → 返回 `[off, on, high, max]`。
 * provider 端按各自协议把任意值映射到 API 参数（如 DeepSeek 把 `xhigh`/`max` 都映射为 `'max'`）。
 *
 * 配置文件不存在或解析失败 → 返回空配置，全量走兜底 `["off", "on"]`。
 *
 * 详见 [../../../docs/utils/README.md](../../../docs/utils/README.md) 「modelThinking.ts」。
 */
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import type { ThinkingLevel } from '@/core/llm/adapter'

/** 兜底档位：未配置 / 未命中 / 解析失败 时返回。 */
const FALLBACK_LEVELS: readonly ThinkingLevel[] = ['off', 'on']

/** 配置条目（YAML 单条）。aliases 含若干模型名（含通配 `"*"`）；thinking 为 YAML 原样数组。 */
export interface ModelThinkingEntry {
  aliases: string[]
  /** YAML 原样数组（按文件顺序），类型上窄到 ThinkingLevel 以便消费方获得自动补全。
   *  因 ThinkingLevel 含 `(string & {})`，运行时可为任意字符串。 */
  thinking: ThinkingLevel[]
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

/**
 * 加载 `.chery/model-thinking.yaml`。幂等：首次加载后 in-memory 缓存。
 * 配置文件不存在 / 解析失败 / aliases 或 thinking 为空 → 返回空 entries（全量走兜底）。
 * 不抛错（启动期已有 config.yaml 兜底；本文件是软依赖）。
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
        ? (item.thinking.filter(
            (l): l is ThinkingLevel => typeof l === 'string',
          ) as ThinkingLevel[])
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
 * 按 model 名查档位（按 YAML 文件原顺序原样返回）。
 * 匹配顺序：精确（aliases 含完整 model） → 最长前缀（aliases 中作为 model 前缀）→ 通配 `*` → 兜底。
 *
 * 例：model="gpt-4o-mini"；aliases 有 "gpt-4o"、"gpt-4-turbo" → 命中 "gpt-4o"（前缀）。
 *     配置 `[off, on, high, max]` → 返回 `[off, on, high, max]`（原样保留）。
 */
export function resolveThinkingLevels(model: string): readonly ThinkingLevel[] {
  const cfg = loadModelThinking()
  if (!model) return FALLBACK_LEVELS

  let entry: ModelThinkingEntry | undefined

  // 1. 精确匹配
  for (const e of cfg.entries) {
    if (e.aliases.includes(model)) {
      entry = e
      break
    }
  }

  // 2. 最长前缀匹配
  if (!entry) {
    let bestLen = -1
    for (const e of cfg.entries) {
      if (e.aliases.includes('*')) continue
      for (const alias of e.aliases) {
        if (model.startsWith(alias) && alias.length > bestLen) {
          entry = e
          bestLen = alias.length
        }
      }
    }
  }

  // 3. 通配 `*` 兜底
  if (!entry) {
    for (const e of cfg.entries) {
      if (e.aliases.includes('*')) {
        entry = e
        break
      }
    }
  }

  // 4. 配置缺失 / 未命中：返回 ["off", "on"]
  if (!entry) return FALLBACK_LEVELS

  return entry.thinking
}

/**
 * 批量查询（RPC utils.thinkingLevels 用）。
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
