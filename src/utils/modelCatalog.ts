/**
 * Model catalog: model-name matching, descriptive facts, editor recommendations,
 * and protocol-specific thinking wire mappings.
 *
 * Recommendations never become runtime defaults. The settings editor may copy
 * them into a brain draft; once saved, config.yaml remains the only source of
 * effective protocol/context/capability values. Wire mappings are adapter
 * metadata and are consulted only to serialize the selected thinking level.
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { isLlmProtocol, type LlmProtocol as LlmProtocolValue } from '@chery/protocol'
import type { ThinkingLevel } from '@/core/llm/adapter.js'

export interface CatalogMediaCapabilities {
  image?: boolean
  video?: boolean
  audio?: boolean
}

export interface CatalogCapabilities {
  toolCall?: boolean
  input?: CatalogMediaCapabilities
  generate?: CatalogMediaCapabilities
}

export interface CatalogThinkingLevel {
  display: ThinkingLevel
  params: Record<string, unknown>
}

export type ReasoningHistoryMode = 'assistant-field' | 'reasoning-item' | 'thinking-block' | 'omit'

export interface ModelWireRule {
  thinking?: CatalogThinkingLevel[]
  reasoningHistory?: ReasoningHistoryMode
}

export interface ModelCatalogFacts {
  /** Vendor-advertised maximum context window. Informational only. */
  contextWindow?: number
  /** Protocols known to be supported by the model's official service. */
  protocols?: LlmProtocolValue[]
  capabilities?: CatalogCapabilities
}

export interface ModelCatalogRecommendation {
  protocol?: LlmProtocolValue
  /** Practical operating limit copied to brain.contextLimit when accepted. */
  contextLimit?: number
  thinking?: ThinkingLevel
  capabilities?: CatalogCapabilities
}

export type ModelMatchPattern =
  | string
  | { exact: string; glob?: never; regex?: never; flags?: never }
  | { glob: string; exact?: never; regex?: never; flags?: never }
  | { regex: string; flags?: string; exact?: never; glob?: never }

export interface ModelCatalogMatchSpec {
  /** Plain strings use glob syntax; structured entries also support exact and regex matching. */
  models: ModelMatchPattern[]
  /** Optional service-entry restriction. Useful for relay-specific aliases. */
  providers?: string[]
}

export interface ModelCatalogRule {
  id: string
  match: ModelCatalogMatchSpec
  facts?: ModelCatalogFacts
  recommend?: ModelCatalogRecommendation
  wire?: Partial<Record<LlmProtocolValue, ModelWireRule>>
}

export interface ModelCatalogUnknownPolicy {
  recommend?: ModelCatalogRecommendation
  capabilities?: CatalogCapabilities
}

export interface ModelCatalogConfig {
  version: number
  unknown: ModelCatalogUnknownPolicy
  models: ModelCatalogRule[]
}

export interface ResolvedModelCatalogEntry {
  matched: boolean
  id?: string
  confidence: 'exact' | 'pattern' | 'unknown'
  facts?: ModelCatalogFacts
  recommend?: ModelCatalogRecommendation
  thinkingLevels: readonly ThinkingLevel[]
  unknown: ModelCatalogUnknownPolicy
}

const CONSERVATIVE_CAPABILITIES: CatalogCapabilities = {
  toolCall: true,
  input: { image: false, video: false, audio: false },
  generate: { image: false, video: false, audio: false },
}

/** Safety fallback used only when the project catalog is missing or invalid. */
const DEFAULT_UNKNOWN: ModelCatalogUnknownPolicy = {
  recommend: {
    contextLimit: 128_000,
    thinking: 'off',
    capabilities: CONSERVATIVE_CAPABILITIES,
  },
  capabilities: CONSERVATIVE_CAPABILITIES,
}

let cached: ModelCatalogConfig | undefined

function resolveCheryDir(): string {
  return process.env.CHERY_DIR || process.cwd()
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function parseMediaCapabilities(raw: unknown): CatalogMediaCapabilities | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const result: CatalogMediaCapabilities = {}
  for (const key of ['image', 'video', 'audio'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseCapabilities(raw: unknown): CatalogCapabilities | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const result: CatalogCapabilities = {}
  if (typeof value.toolCall === 'boolean') result.toolCall = value.toolCall
  const input = parseMediaCapabilities(value.input)
  const generate = parseMediaCapabilities(value.generate)
  if (input) result.input = input
  if (generate) result.generate = generate
  return Object.keys(result).length > 0 ? result : undefined
}

function parseThinking(raw: unknown): CatalogThinkingLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const result: CatalogThinkingLevel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const value = item as { display?: unknown; params?: unknown }
    if (typeof value.display !== 'string' || value.display.trim() === '') continue
    if (
      value.params !== undefined &&
      value.params !== null &&
      (typeof value.params !== 'object' || Array.isArray(value.params))
    ) {
      continue
    }
    result.push({
      display: value.display,
      params: (value.params ?? {}) as Record<string, unknown>,
    })
  }
  return result.length > 0 ? result : undefined
}

function parseWire(raw: unknown): ModelCatalogRule['wire'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const result: NonNullable<ModelCatalogRule['wire']> = {}
  for (const [protocol, protocolRaw] of Object.entries(raw)) {
    if (!isLlmProtocol(protocol) || !protocolRaw || typeof protocolRaw !== 'object') continue
    const value = protocolRaw as { thinking?: unknown; reasoningHistory?: unknown }
    const thinking = parseThinking(value.thinking)
    const reasoningHistory = [
      'assistant-field',
      'reasoning-item',
      'thinking-block',
      'omit',
    ].includes(String(value.reasoningHistory))
      ? (value.reasoningHistory as ReasoningHistoryMode)
      : undefined
    if (thinking || reasoningHistory) {
      result[protocol] = {
        ...(thinking ? { thinking } : {}),
        ...(reasoningHistory ? { reasoningHistory } : {}),
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseFacts(raw: unknown): ModelCatalogFacts | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const contextWindow = positiveNumber(value.contextWindow)
  const protocols = Array.isArray(value.protocols)
    ? value.protocols.filter(isLlmProtocol)
    : undefined
  const capabilities = parseCapabilities(value.capabilities)
  const result: ModelCatalogFacts = {
    ...(contextWindow ? { contextWindow } : {}),
    ...(protocols && protocols.length > 0 ? { protocols } : {}),
    ...(capabilities ? { capabilities } : {}),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseRecommendation(raw: unknown): ModelCatalogRecommendation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const protocol = isLlmProtocol(value.protocol) ? value.protocol : undefined
  const contextLimit = positiveNumber(value.contextLimit)
  const thinking =
    typeof value.thinking === 'string' && value.thinking.trim() !== '' ? value.thinking : undefined
  const capabilities = parseCapabilities(value.capabilities)
  const result: ModelCatalogRecommendation = {
    ...(protocol ? { protocol } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    ...(thinking ? { thinking } : {}),
    ...(capabilities ? { capabilities } : {}),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseRule(raw: unknown): ModelCatalogRule | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id.trim() === '') return undefined
  if (!value.match || typeof value.match !== 'object' || Array.isArray(value.match))
    return undefined
  const match = value.match as Record<string, unknown>
  const models: ModelMatchPattern[] = []
  for (const model of Array.isArray(match.models) ? match.models : []) {
    if (typeof model === 'string' && model.trim() !== '') {
      models.push(model)
      continue
    }
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue
    const pattern = model as Record<string, unknown>
    if (typeof pattern.exact === 'string' && pattern.exact.trim() !== '') {
      models.push({ exact: pattern.exact })
    } else if (typeof pattern.glob === 'string' && pattern.glob.trim() !== '') {
      models.push({ glob: pattern.glob })
    } else if (typeof pattern.regex === 'string' && pattern.regex.trim() !== '') {
      models.push({
        regex: pattern.regex,
        ...(typeof pattern.flags === 'string' ? { flags: pattern.flags } : {}),
      })
    }
  }
  if (models.length === 0) return undefined
  const providers = Array.isArray(match.providers)
    ? match.providers.filter(
        (provider): provider is string => typeof provider === 'string' && provider.trim() !== '',
      )
    : undefined
  const facts = parseFacts(value.facts)
  const recommend = parseRecommendation(value.recommend)
  const wire = parseWire(value.wire)
  return {
    id: value.id,
    match: {
      models,
      ...(providers && providers.length > 0 ? { providers } : {}),
    },
    ...(facts ? { facts } : {}),
    ...(recommend ? { recommend } : {}),
    ...(wire ? { wire } : {}),
  }
}

function parseUnknown(raw: unknown): ModelCatalogUnknownPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_UNKNOWN
  const value = raw as Record<string, unknown>
  return {
    ...(parseRecommendation(value.recommend)
      ? { recommend: parseRecommendation(value.recommend) }
      : {}),
    capabilities: parseCapabilities(value.capabilities) ?? DEFAULT_UNKNOWN.capabilities,
  }
}

/** Load the user-adjustable project catalog; concrete vendor rules live in YAML, not code. */
export function loadModelCatalog(): ModelCatalogConfig {
  if (cached) return cached
  const byId = new Map<string, ModelCatalogRule>()
  let unknown = DEFAULT_UNKNOWN
  let version = 1
  const configPath = path.join(resolveCheryDir(), '.chery', 'model-catalog.yaml')
  if (fs.existsSync(configPath)) {
    try {
      const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as {
        version?: unknown
        unknown?: unknown
        models?: unknown[]
      } | null
      if (typeof raw?.version === 'number' && Number.isInteger(raw.version) && raw.version > 0) {
        version = raw.version
      }
      unknown = parseUnknown(raw?.unknown)
      for (const item of raw?.models ?? []) {
        const rule = parseRule(item)
        if (rule) byId.set(rule.id, rule)
      }
    } catch {
      // The catalog is a soft dependency. Invalid project YAML keeps the conservative fallback.
    }
  }
  cached = { version, unknown, models: [...byId.values()] }
  return cached
}

function modelCandidates(model: string): string[] {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return []
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? [normalized, normalized.slice(slash + 1)] : [normalized]
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function matchPatternScore(pattern: ModelMatchPattern, model: string): number {
  const candidates = modelCandidates(model)
  if (typeof pattern !== 'string' && typeof pattern.regex === 'string') {
    try {
      const flags = [...new Set(`${pattern.flags ?? ''}i`.replace(/[gy]/g, '').split(''))].join('')
      const expression = new RegExp(pattern.regex, flags)
      return candidates.some((candidate) => expression.test(candidate))
        ? 2_000_000 + pattern.regex.length
        : -1
    } catch {
      return -1
    }
  }
  const raw =
    typeof pattern === 'string'
      ? pattern
      : typeof pattern.exact === 'string'
        ? pattern.exact
        : (pattern.glob ?? '')
  const normalizedPattern = raw.trim().toLowerCase()
  if (!normalizedPattern) return -1
  const exact = typeof pattern !== 'string' ? 'exact' in pattern : !normalizedPattern.includes('*')
  for (const candidate of candidates) {
    if (exact && candidate === normalizedPattern) return 3_000_000 + normalizedPattern.length
    if (!exact && globRegex(normalizedPattern).test(candidate)) {
      return 1_000_000 + normalizedPattern.replace(/\*/g, '').length
    }
  }
  return -1
}

function matchRuleScore(rule: ModelCatalogRule, model: string, provider?: string): number {
  if (
    rule.match.providers?.length &&
    (!provider ||
      !rule.match.providers.some((item) => item.toLowerCase() === provider.toLowerCase()))
  ) {
    return -1
  }
  let score = -1
  for (const pattern of rule.match.models) {
    score = Math.max(score, matchPatternScore(pattern, model))
  }
  return score
}

export function resolveModelCatalogRule(
  model: string,
  provider?: string,
): { rule: ModelCatalogRule; confidence: 'exact' | 'pattern' } | undefined {
  let best: ModelCatalogRule | undefined
  let bestScore = -1
  for (const rule of loadModelCatalog().models) {
    const score = matchRuleScore(rule, model, provider)
    if (score > bestScore) {
      best = rule
      bestScore = score
    }
  }
  if (!best || bestScore < 0) return undefined
  return { rule: best, confidence: bestScore >= 3_000_000 ? 'exact' : 'pattern' }
}

export function resolveModelCatalog(input: {
  model: string
  provider?: string
  protocol?: LlmProtocolValue
}): ResolvedModelCatalogEntry {
  const catalog = loadModelCatalog()
  const matched = resolveModelCatalogRule(input.model, input.provider)
  const wire = input.protocol ? matched?.rule.wire?.[input.protocol] : undefined
  if (!matched) {
    const configured = catalog.unknown.recommend
    const recommend: ModelCatalogRecommendation = {
      ...(input.protocol ? { protocol: input.protocol } : {}),
      ...configured,
      capabilities: configured?.capabilities ?? catalog.unknown.capabilities,
    }
    return {
      matched: false,
      confidence: 'unknown',
      recommend,
      thinkingLevels: [],
      unknown: catalog.unknown,
    }
  }
  return {
    matched: true,
    id: matched.rule.id,
    confidence: matched.confidence,
    facts: matched.rule.facts,
    recommend: matched.rule.recommend,
    thinkingLevels: wire?.thinking?.map((entry) => entry.display) ?? [],
    unknown: catalog.unknown,
  }
}

export function resolveCatalogThinkingLevels(input: {
  model: string
  provider?: string
  protocol?: LlmProtocolValue
}): readonly ThinkingLevel[] {
  return resolveModelCatalog(input).thinkingLevels
}

export function resolveCatalogThinkingParams(input: {
  model: string
  provider?: string
  protocol?: LlmProtocolValue
  display?: string
}): Record<string, unknown> | undefined {
  if (!input.protocol || !input.display) return undefined
  const matched = resolveModelCatalogRule(input.model, input.provider)
  const level = matched?.rule.wire?.[input.protocol]?.thinking?.find(
    (entry) => entry.display === input.display,
  )
  return level && Object.keys(level.params).length > 0 ? level.params : undefined
}

export function resolveCatalogReasoningHistory(input: {
  model: string
  provider?: string
  protocol?: LlmProtocolValue
}): ReasoningHistoryMode | undefined {
  if (!input.protocol) return undefined
  return resolveModelCatalogRule(input.model, input.provider)?.rule.wire?.[input.protocol]
    ?.reasoningHistory
}

/** Known facts are advisory for relay/custom providers, so callers should warn rather than block. */
export function modelCatalogSupportsProtocol(input: {
  model: string
  provider?: string
  protocol: LlmProtocolValue
}): boolean {
  const protocols = resolveModelCatalogRule(input.model, input.provider)?.rule.facts?.protocols
  return !protocols || protocols.includes(input.protocol)
}

/** Tests and config hot-reload use this to force a fresh project catalog read. */
export function resetModelCatalogCache(): void {
  cached = undefined
}
