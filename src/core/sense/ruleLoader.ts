/**
 * smart 监管规则表加载器（.chery/rule/）。
 *
 * 职责：扫描规则文件 + base/overlay 深合并 + 编译（extract 字段名→闭包、pattern 串→RegExp）。
 * I/O 与解析集中于此；sensitivity.ts 的 isSafeSenseCall 保持纯函数零 I/O。
 *
 * 调用方：RuntimeResolver.resolve 期调 loadMergedRuleSet(ruleName) 一次，编译结果冻结入
 *   RuntimeConfig.sensitivityRules，随 chat 生命周期（ensureChat 对已有 chat 不 re-configure →
 *   进程内冻结，resume 续接结论一致）。
 *
 * rules.list RPC 调 listRules() 返覆盖文件名（排除 base.yaml 基准）。
 *
 * 设计原则（对齐 sensitivity.ts）：
 *   1. 确定性：纯数据 yaml → 同输入同编译结果（resume 一致前提）。
 *   2. fail-open：文件缺失/解析异常 → 回退空规则（黑名单下未知 sense 全放行；破坏性 sense 靠 false 或档位兜底）。
 */
import { readdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import yaml from 'js-yaml'
import config from '@/utils/config.js'

/** 编译后规则（含闭包/RegExp，不可序列化） */
export interface CompiledRule {
  /** 从 args 取待匹配字段（如 execute_command 的 command 串） */
  extract?: (args: Record<string, unknown>) => string
  /** 危险操作黑名单：substring 或 RegExp，命中即需确认（保持 smart 审批） */
  dangerPatterns?: Array<string | RegExp>
}
export type CompiledRuleSet = Record<string, CompiledRule | false>

/** YAML 磁盘形态（纯数据可序列化） */
interface RuleFileEntry {
  extract?: string
  dangerPatterns?: string[]
  /**
   * 仅 overlay 条目生效（base 无意义，base 即被继承/覆盖的基底）。
   * - 缺省 / true → 深合并：extract 取 overlay、dangerPatterns base+overlay 追加去重
   * - false → replace：纯用 overlay，丢弃 base 同名条目（extract + dangerPatterns 全取 overlay）
   */
  inherit?: boolean
}

/** 基准文件固定名（合并默认基底，前端下拉不可选） */
export const BASE_RULE_FILE = 'base.yaml'

/**
 * 列 .chery/rule/*.yaml 裸文件名（**排除 base.yaml**）。
 * 单一 choke point：前端 rules.list 下拉不可能选到基准。
 * 目录不存在/为空 → []（合法，不 fail loud）。
 */
export function listRules(): string[] {
  const dir = config.global.rule_dir
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith('.yaml') && e.name !== BASE_RULE_FILE,
    )
    .map((e) => e.name)
    .sort()
}

/** extract 字段名 → 取参闭包（支持点号路径：'command' / 'input.path'） */
function compileExtract(field: string): (args: Record<string, unknown>) => string {
  return (args) => {
    const v = field
      .split('.')
      .reduce<unknown>(
        (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
        args,
      )
    return typeof v === 'string' ? v : ''
  }
}

/** pattern 串 → string(子串) | RegExp。约定 /^\/(.+)\/([gimsuy]*)$/ 为正则，否则子串 */
function compilePattern(p: string): string | RegExp {
  const m = p.match(/^\/(.+)\/([gimsuy]*)$/)
  return m && m[1] !== undefined ? new RegExp(m[1], m[2] ?? '') : p
}

/** 去重键：字符串 's:v'，正则 'r:source:flags' */
function patternKey(p: string | RegExp): string {
  return typeof p === 'string' ? `s:${p}` : `r:${p.source}:${p.flags}`
}

/**
 * 深合并单条（overlay 决定形态）：
 *   - overlay false → false（强声明：整体敏感）
 *   - overlay 对象 + base 对象 + inherit:false → replace：纯 overlay，丢弃 base
 *   - overlay 对象 + base 对象（缺省/true）→ extract 取 overlay、dangerPatterns base+overlay 追加去重
 *   - overlay 对象 + base 无/false → 纯 overlay
 */
function mergeEntry(
  base: RuleFileEntry | false | undefined,
  overlay: RuleFileEntry | false,
): CompiledRule | false {
  if (overlay === false) return false
  if (base === false || base === undefined) {
    return {
      extract: overlay.extract ? compileExtract(overlay.extract) : undefined,
      dangerPatterns: overlay.dangerPatterns?.map(compilePattern),
    }
  }
  // base + overlay 均对象：inherit:false → replace，丢弃 base 同名条目
  if (overlay.inherit === false) {
    return {
      extract: overlay.extract ? compileExtract(overlay.extract) : undefined,
      dangerPatterns: overlay.dangerPatterns?.map(compilePattern),
    }
  }
  // base + overlay 均对象 → 深合并
  const extractField = overlay.extract ?? base.extract
  const merged: Array<string | RegExp> = [
    ...(base.dangerPatterns ?? []).map(compilePattern),
    ...(overlay.dangerPatterns ?? []).map(compilePattern),
  ]
  const seen = new Set<string>()
  const dangerPatterns: Array<string | RegExp> = []
  for (const p of merged) {
    const k = patternKey(p)
    if (!seen.has(k)) {
      seen.add(k)
      dangerPatterns.push(p)
    }
  }
  return {
    extract: extractField ? compileExtract(extractField) : undefined,
    dangerPatterns,
  }
}

/** 读单个规则文件（缺失/解析失败 → 空对象，warn 不抛） */
function loadFile(name: string): Record<string, RuleFileEntry | false> {
  const full = join(config.global.rule_dir, name)
  if (!existsSync(full)) return {}
  try {
    return (yaml.load(readFileSync(full, 'utf8')) as Record<string, RuleFileEntry | false>) ?? {}
  } catch (e) {
    console.warn(`[ruleLoader] ${name} 解析失败，回退空规则：`, (e as Error).message)
    return {}
  }
}

/**
 * 深合并 base + overlay（per sense），编译冻结入 RuntimeConfig。
 * base 缺失 → 空 ruleSet（smart 全 false 保守）；overlay 缺失 → 纯 base。
 */
export function loadMergedRuleSet(ruleName?: string): CompiledRuleSet {
  const base = loadFile(BASE_RULE_FILE)
  const overlay = ruleName ? loadFile(ruleName) : {}
  const result: CompiledRuleSet = {}
  // base 全量；overlay 同名则深合并
  for (const [k, v] of Object.entries(base)) {
    result[k] = overlay[k] !== undefined ? mergeEntry(v, overlay[k]!) : mergeEntry(undefined, v)
  }
  // base 无、overlay 有的条目
  for (const [k, v] of Object.entries(overlay)) {
    if (result[k] === undefined) result[k] = mergeEntry(undefined, v)
  }
  return result
}
