/**
 * Hooks 注册表：加载 `.chery/hooks/hooks.json`（全局）+ brain 级覆盖。
 *
 * 设计：
 * - 启动期一次性解析到内存表（dispatcher O(1) 查表）
 * - handler 进程不预热（仿 mock 哲学：每次 dispatch 按需 spawn，dev 改 hooks.json 免重启）
 * - 文件不存在或解析失败 → log + 空表（graceful degradation：不阻断启动）
 *
 * 详见 [docs/agent/hooks.md](../../../../docs/agent/hooks.md)。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger, LogLevel } from '@/utils/logger/index.js'
import config from '@/utils/config.js'
import { resolvePosixShell } from '@/core/security/sandbox.js'
import type { HookEvent } from './types.js'
import type { HookHandlerConfig } from './matcher.js'

/** 事件 → handler 列表（保留声明顺序）*/
export type HookHandlerMap = Partial<Record<HookEvent, HookHandlerConfig[]>>

/** 解析后的内存表：event → handler 列表（含 brain 级合并）*/
let handlersCache: HookHandlerMap | null = null

/** 全局 hooks.json 路径（相对 .chery/）*/
const GLOBAL_HOOKS_FILE = 'hooks/hooks.json'

/**
 * 加载并缓存 hooks handler 表。
 * - 全局：读 `.chery/hooks/hooks.json`
 * - brain 级：读 `BrainConfig.hooks` 指定路径（合并覆盖）
 *
 * 启动期调用一次；dispatch 时按需 read handler command（dev 改 hooks.json 免重启）。
 */
export function loadHookRegistry(): HookHandlerMap {
  if (handlersCache) return handlersCache

  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const globalPath = join(cheryDir, '.chery', GLOBAL_HOOKS_FILE)
  const global = loadHooksFile(globalPath, 'global')

  // 合并 brain 级：每个 brain 的 hooks 路径独立加载
  const merged: HookHandlerMap = global ? { ...global } : {}
  for (const [brainName, brainCfg] of Object.entries(config.llm.brain)) {
    if (!brainCfg.hooks) continue
    const brainPath = join(cheryDir, '.chery', brainCfg.hooks)
    const brainHooks = loadHooksFile(brainPath, brainName)
    if (!brainHooks) continue
    // 合并：brain 级 handler 追加到全局同事件列表后
    for (const ev of Object.keys(brainHooks) as HookEvent[]) {
      const brainList = brainHooks[ev]
      if (!brainList) continue
      const globalList = merged[ev] ?? []
      merged[ev] = [...globalList, ...brainList]
    }
  }

  handlersCache = merged
  // 启动期健康检查（先例：git 导入的 gitNotInstalled 预探测）：注册了 handler 但
  // POSIX shell 不可用 → 显著 warn 提前暴露（Windows 无 sh 会阻断每次 dispatch，
  // 见 docs/agent/hooks.md「跨平台执行」失败语义表），而非在会话中反复撞墙。
  const handlerCount = Object.values(merged).reduce((sum, list) => sum + (list?.length ?? 0), 0)
  if (handlerCount > 0) {
    try {
      resolvePosixShell()
    } catch (err) {
      logger.event(
        'hooks.registry.shell_unavailable',
        { handlerCount, error: (err as Error).message },
        LogLevel.warn,
      )
    }
  }
  logger.event('hooks.registry.loaded', {
    globalExists: !!global,
    eventCount: Object.keys(merged).length,
    handlerCount: Object.values(merged).reduce((sum, list) => sum + (list?.length ?? 0), 0),
  })
  return merged
}

/** 读取单个 hooks.json，schema 校验，失败返回 null（不阻断）*/
function loadHooksFile(absPath: string, source: string): HookHandlerMap | null {
  if (!existsSync(absPath)) {
    if (source === 'global') {
      // 全局 hooks.json 不存在是正常（用户未配置）→ DEBUG 级静默
      logger.event('hooks.registry.global_missing', { absPath }, LogLevel.debug)
    }
    return null
  }

  let raw: string
  try {
    raw = readFileSync(absPath, 'utf8')
  } catch (err) {
    logger.event(
      'hooks.registry.read_failed',
      { absPath, source, error: (err as Error).message },
      LogLevel.warn,
    )
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.event(
      'hooks.registry.parse_failed',
      { absPath, source, error: (err as Error).message },
      LogLevel.warn,
    )
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.event('hooks.registry.invalid_shape', { absPath, source }, LogLevel.warn)
    return null
  }

  const validated = validateHooksConfig(parsed as Record<string, unknown>)
  return validated
}

/** schema 校验：事件名必须是 HookEvent；handler 必须是数组；每项含 command */
function validateHooksConfig(raw: Record<string, unknown>): HookHandlerMap {
  const validEvents = new Set<string>([
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PreLLMRequest',
    'PostLLMResponse',
    'PreToolUse',
    'PostToolUse',
    'Stop',
    'PreCompact',
    'PostCompact',
  ])
  const result: HookHandlerMap = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!validEvents.has(key)) {
      logger.event('hooks.registry.unknown_event', { event: key }, LogLevel.warn)
      continue
    }
    if (!Array.isArray(value)) {
      logger.event('hooks.registry.handler_not_array', { event: key }, LogLevel.warn)
      continue
    }
    const handlers: HookHandlerConfig[] = []
    for (let i = 0; i < value.length; i++) {
      const item = value[i]
      if (!item || typeof item !== 'object') {
        logger.event('hooks.registry.handler_invalid', { event: key, index: i }, LogLevel.warn)
        continue
      }
      const h = item as Record<string, unknown>
      if (typeof h.command !== 'string' || !h.command) {
        logger.event('hooks.registry.handler_no_command', { event: key, index: i }, LogLevel.warn)
        continue
      }
      handlers.push({
        matcher: typeof h.matcher === 'string' ? h.matcher : undefined,
        if: typeof h.if === 'string' ? h.if : undefined,
        command: h.command,
        timeout: typeof h.timeout === 'number' ? h.timeout : undefined,
      })
    }
    if (handlers.length > 0) {
      result[key as HookEvent] = handlers
    }
  }
  return result
}

/** 测试/重载用：清空缓存 */
export function clearHookRegistry(): void {
  handlersCache = null
}

// ============ 公共读写函数（service hooks handler 复用）============

/** 读取全局 hooks.json（不合并 brain 级），不存在返回空对象 */
export function readGlobalHooks(): HookHandlerMap {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const globalPath = join(cheryDir, '.chery', GLOBAL_HOOKS_FILE)
  return loadHooksFile(globalPath, 'global') ?? {}
}

/** 读取各 brain 级 hooks（brain 名 → HookHandlerMap），跳过无 hooks 配置的 brain */
export function readBrainHooksMap(): Record<string, HookHandlerMap> {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const result: Record<string, HookHandlerMap> = {}
  for (const [brainName, brainCfg] of Object.entries(config.llm.brain)) {
    if (!brainCfg.hooks) continue
    const brainPath = join(cheryDir, '.chery', brainCfg.hooks)
    const hooks = loadHooksFile(brainPath, brainName)
    if (hooks) result[brainName] = hooks
  }
  return result
}

/** 写入全局 hooks.json + 清缓存。路径不存在时自动创建目录。 */
export function writeGlobalHooks(handlers: HookHandlerMap): void {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const globalPath = join(cheryDir, '.chery', GLOBAL_HOOKS_FILE)
  mkdirSync(dirname(globalPath), { recursive: true })
  writeFileSync(globalPath, JSON.stringify(handlers, null, 2), 'utf8')
  clearHookRegistry()
}
