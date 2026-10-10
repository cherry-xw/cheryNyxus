import type { RoleConfig, PresetConfig, Threshold, CommandConfig, ServerConfig, McpServerConfig, Config, ConfigRaw } from '@chery/plugin-api'
export type { MockScriptError, MockScriptChunk, MockScriptResponse, MockConfig, MediaCapabilities, BrainCapabilities, BrainConfig, LLMConfig, RolePermissionTemplate, RolePermissionEffect, CommandRiskCategory, RolePermissionPolicy, RoleConfig, PresetConfig, PresetSchedule, MemoryLimits, MemoryConfig, FileCompressionConfig, LoggerConfig, Threshold, CommandConfig, HistoryRecallConfig, GlobalConfig, ServerConfig, ManagerConfig, WorkspaceBrowseConfig, McpServerConfig, ExtendedGlobalConfig, Config, GlobalConfigRaw, McpServerConfigRaw, ConfigRaw } from '@chery/plugin-api'
import dotenv from 'dotenv'
import yaml from 'js-yaml'
import { validateFixedPresetEdits, validateLockedRoleEdits } from './lockedRole.js'
import {
  ENV_PLACEHOLDER_RE,
  envPlaceholderFormatError,
  isMalformedEnvPlaceholder,
} from './envPlaceholder.js'
import fs from 'fs'
import path from 'path'
import { createHash } from 'node:crypto'
import { resolveEnvFile, loadEnvFile, ensureSessionSecret } from './envFile.js'

import { SupervisionLevel } from '@/core/config'
import type { ThinkingLevel } from '@/core/llm/adapter'
import { validateRoleAvatar } from '@/utils/roleAvatar.js'
import { findLlmProviderDefinition, isLlmProtocol } from '@chery/protocol'

// Explicit file selection is fixed at startup; loading preserves inherited variables.
const inheritedEnvironment = { ...process.env }
const rootEnvPath = resolveEnvFile(import.meta.url)
// Channel transport credentials are deployment-only, not general configuration.
const deploymentKeys = new Set(
  Object.keys(
    dotenv.parse(fs.existsSync(rootEnvPath) ? fs.readFileSync(rootEnvPath, 'utf8') : ''),
  ).filter((key) => /(?:PLATFORM_TOKEN|CONFIG_READY_REVISION|CONFIG_REVISION)$/.test(key)),
)
loadEnvFile(rootEnvPath, process.env, { excludedKeys: deploymentKeys })

function withoutDeploymentSecrets(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key]) => !/(?:PLATFORM_TOKEN|CONFIG_READY_REVISION|CONFIG_REVISION)$/.test(key),
    ),
  )
}

// 会话签名密钥持久化：确保后端同级的 .env（rootEnvPath）存在 CHERY_AUTH_SESSION_SECRET，跨重启复用。
// 必须在 config.yaml 加载前注入 process.env，供 server.auth 会话签名读取。
ensureAuthSessionSecret()
let managedEnvFileValues = listEnvVarMap()

/**
 * 生成/复用会话签名密钥，只写入启动时选定的环境文件。
 * - 进程环境已设置：直接复用，不改文件。
 * - .env 已含该键：读入注入进程环境。
 * - 否则生成 32 字节随机 hex 并追加写入。
 * CHERY_ENV_FILE 可指定独立文件；CHERY_DIR 指项目根，不再使用 .chery/.env。
 * 失效/轮换方案：删除 .env 中该行（或整文件）后重启，即重新生成新密钥，
 * 所有已签发 access/refresh token 立即失效（HMAC 验签失败），需重新登录。
 */
function ensureAuthSessionSecret(): void {
  ensureSessionSecret(rootEnvPath)
}

// 从 core 层重新导出 SupervisionLevel
export { SupervisionLevel } from '@/core/config'

/**
 * mock provider 脚本项（单次 LLM 调用的预定响应）
 * 用于离线测试 send/resume/revoke/loop 流程，不接真实 LLM。
 */


/** One deterministic provider stream step. Error is thrown after this step's deltas are yielded. */




/**
 * mock 配置（brain 内）：只保留开关 + 脚本文件路径 + 全局延迟兜底。
 * 脚本内容（repeat + script[]）放独立文件，避免 config.yaml 过长。
 */


/** 模型声明的媒体能力。 */


/** 缺省兼容旧配置：toolCall=true，其余能力=false。 */


/**
 * Brain 配置基础类型
 * 各 Provider 可扩展具体配置结构
 */


/**
 * 把 brain.thinking 归一化为 ThinkingLevel（档位「显示词」）。
 * - legacy boolean：true→"on"、false→"off"
 * - undefined/缺省 → "off"（模型目录未声明 wire 时一律不发思考参数）
 * - 任意非空字符串（显示词，含自定义档位如 `max`）→ 原样；请求参数由 model-catalog.yaml 翻译
 * - 空串/其他非法值 → "off"（兜底）
 *
 * 在 loadConfig（运行时）和 readRawConfig（RPC 读，前端拿到的就是显示词）两处调用，
 * 保证 ctx.runtime.brain.thinking 与前端 DTO 都规范化。
 */
function normalizeBrainThinking(v: unknown): ThinkingLevel {
  if (v === true) return 'on'
  if (v === false || v === null) return 'off'
  if (v === undefined) return 'off'
  if (typeof v === 'string' && v.trim() !== '') return v as ThinkingLevel
  return 'off'
}








/**
 * 角色行为权限。senseGroup 决定「能看见哪些工具」，本策略决定「本次调用能否执行」。
 * allow 只表示本角色不额外收紧，不能绕过系统守卫、全局监管或语义风险判断。
 */


/**
 * 角色配置（spawn_role sense 按 type 查这里；预设 leader 角色亦由此定义）。
 * 名 = 给 AI 的角色名；brain 必须存在于 llm.brain（loadConfig 校验）。
 * systemPrompt = 专属 system prompt 文件路径（相对 .chery 目录）；
 *   缺省 → 角色用全局 system_prompt。per-role system prompt（T7）。
 */


/**
 * 预设：选中的角色 type 列表（引用 config.roles 单一源，不在预设内重定义编制）+ 指定组长。
 * 主 pet 启动选一套，编制运行后不可改；主 pet 编制取 leader 角色的 RoleConfig。
 * 旧 config.default 已并入「默认」预设（DEFAULT_PRESET_NAME）。
 */


/** Deterministic compatibility id for configs created before preset ids existed. */
export function legacyPresetId(name: string): string {
  return `preset-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}

/** Deterministic compatibility id for configs created before role ids existed. */
export function legacyRoleId(name: string): string {
  return `role-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`
}

/** 缺省 kind 兼容现有配置：未声明的一律是普通角色。 */
export function isShadowRole(
  role: RoleConfig | undefined,
): role is RoleConfig & { kind: 'shadow' } {
  return role?.kind === 'shadow'
}

export function isOrdinaryRole(role: RoleConfig | undefined): role is RoleConfig {
  return !!role && !isShadowRole(role)
}

function ensurePresetIds(presets?: Record<string, PresetConfig>): void {
  if (!presets) return
  for (const [name, preset] of Object.entries(presets)) {
    if (!preset.id?.trim()) preset.id = legacyPresetId(name)
  }
}

/** 补全缺失的角色稳定 id（缺省按名字确定性生成，见 legacyRoleId）。 */
export function ensureRoleIds(roles?: Record<string, RoleConfig>): void {
  if (!roles) return
  for (const [name, role] of Object.entries(roles)) {
    if (!role.id?.trim()) role.id = legacyRoleId(name)
  }
}

/** 预设定时触发器配置 */


/** 默认预设名：旧 config.default 迁移目标。/api/config default 字段 + brain.list default 标记据此派生 */
export const DEFAULT_PRESET_NAME = '默认'

/**
 * 记忆配置（双层模型：global 跨 chat 共享 · workspace per chat / per 项目）。
 *
 * 存储路径：
 *   global    → .chery/memory/global/
 *   workspace → .chery/workspace/<sha256(path)[:12]>/（workspace 模式）
 *            或 .chery/memory/（非 workspace chat；与 global 子目录并列）
 *
 * 活跃记忆上限触发淘汰；淘汰记忆移入该层 history/。
 * 每层独立计数、独立限制，互不影响。
 */

/** 单层记忆的活跃条数 / 单条字数软限制（缺省由 MemoryConfig 默认值兜底） */




/**
 * 文件压缩配置
 */


/**
 * 日志配置
 */


/**
 * 阈值：支持 tokens（绝对）或 percent（0..1 占 context 窗口比）两种单位。
 * 前端填写**必须以 `%` 或 `k` 结尾**（如 `50%` / `64k`，不接受裸数字）；后端只处理结构体（确定性，规则 5）。
 */


/**
 * 命令系统配置（控制 /compact 等内置命令的触发与可见性）。
 *
 * 触发语义：
 * - `warn` → 前端视觉提示阈值（到达 → 提示用户可压缩）；**不参与后端触发**，仅投影给前端比对 contextUsage。
 * - `auto` → 自动触发阈值（`thresholdReached(auto, used, total)` 命中即压缩）；支持 tokens/percent。
 * - `min_context_limit` → 启用 compact 功能所需的 brain.contextLimit 下限（「不可用」门槛，仅 tokens）；
 *   低于此值的 brain 上无 compact 价值（mock_test 8K 等）。
 * - `safety_margin` → `used + safety_margin > total` 时强制触发（小 context 溢出防御，弥补百分比不达标的角落场景；内部默认，不入 UI）。
 *
 * compact 无开关：可用性只由 `brain.contextLimit >= min_context_limit`（+ compact.md 存在）决定，
 * 临时换模型按当次发送的 brain 判定。
 */


export const DEFAULT_COMMAND_CONFIG = {
  warn: { unit: 'percent', value: 0.6 } as const,
  auto: { unit: 'percent', value: 0.8 } as const,
  min_context_limit: 32000,
  safety_margin: 1024,
} as const satisfies Required<Omit<CommandConfig, 'warn' | 'auto'>> &
  Record<'warn' | 'auto', Threshold>

/**
 * history_recall 感官（长会话历史回忆，只读）配置。
 */


/**
 * 全局配置
 */


/**
 * 服务配置（端口 + 传输格式，从环境变量迁移至此）
 */


/** 本地管理器（独立进程，见 apps/manager/）监听配置。server 侧专属：config.get 剥离、config.save 原样保留。 */


/** 文件夹浏览协议（config.workspace.browse.*）配置。 */


/**
 * MCP server 单项配置
 * transport=stdio 时用 command/args/env 启动子进程；transport=streamable-http 时用 url 连接远程 server。
 * supervision 为 server 级默认监管等级（覆盖 global.supervision），可被 sense_groups 的 :level 进一步覆盖。
 */


/**
 * 扩展全局配置（包含自动补全的路径）
 */




/**
 * 原始（磁盘/YAML）全局配置：supervision 为字符串（未转枚举）、无路径补全。
 * 供 config.get/config.save RPC 传输与编辑。
 */


/** 原始 MCP server 配置：supervision 为字符串（未转枚举） */


/**
 * 原始配置（config.get 返回 / config.save 入参）：无 server 段、无路径补全、
 * supervision 为字符串、key 仍为 $ENV 占位符。读写均不碰运行时内存单例（重启生效）。
 * export 供 config_manage 感官复用 saveRawConfig 入参类型。
 */


function resolveEnvVars(
  value: unknown,
  environment: Readonly<Record<string, string | undefined>>,
  missing: Set<string>,
): unknown {
  if (typeof value === 'string') {
    const envVarMatch = value.match(/^\$([A-Z_][A-Z0-9_]*)$/)
    if (envVarMatch && envVarMatch[1]) {
      const envVarName = envVarMatch[1]
      const envValue = environment[envVarName]
      if (!envValue) {
        missing.add(envVarName)
        return value // 原样返回
      }
      return envValue
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvVars(entry, environment, missing))
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveEnvVars(val, environment, missing)
    }
    return result
  }

  return value
}

function readRuntimeEnvironment(): Record<string, string | undefined> {
  let fileEnvironment: Record<string, string> = {}
  try {
    fileEnvironment = dotenv.parse(fs.readFileSync(rootEnvPath, 'utf8'))
  } catch {
    // .env is optional; process.env remains authoritative.
  }
  return { ...fileEnvironment, ...process.env }
}

export function replaceEnvVars(value: unknown): unknown {
  return resolveEnvVars(value, readRuntimeEnvironment(), new Set())
}

export type RuntimeConfigSource = ConfigRaw & { server?: Partial<ServerConfig> }

export interface RuntimeConfigNormalizationContext {
  cheryDir: string
  dbDir?: string
  webPort?: string
  environment: Readonly<Record<string, string | undefined>>
  server?: Partial<ServerConfig>
}

export interface PreparedRuntimeConfig {
  raw: ConfigRaw
  config: Config
}

/** Pure conversion shared by startup and hot apply. The input remains the raw
 * placeholder-bearing source; paths and environment values exist only in the result. */
export function normalizeRuntimeConfig(
  raw: RuntimeConfigSource,
  context: RuntimeConfigNormalizationContext,
): Config {
  const source = structuredClone(raw)
  const rawErrors = validateRawConfig(source)
  if (rawErrors.length > 0) throw new Error(`配置校验失败:\n${rawErrors.join('\n')}`)

  const config = resolveEnvVars(source, context.environment, new Set()) as Config

  ensurePresetIds(config.presets)
  ensureRoleIds(config.roles)

  // 将字符串转换为枚举（校验已保证 supervision 为合法值）
  if (typeof config.global.supervision === 'string') {
    config.global.supervision =
      SupervisionLevel[config.global.supervision as keyof typeof SupervisionLevel]
  }

  // MCP servers supervision 字符串转枚举（同 global.supervision 模式）
  if (config.mcp_servers) {
    for (const serverCfg of Object.values(config.mcp_servers)) {
      if (typeof serverCfg.supervision === 'string') {
        serverCfg.supervision =
          SupervisionLevel[serverCfg.supervision as keyof typeof SupervisionLevel]
      }
    }
  }

  // roles.*.systemPrompt 相对路径 → 绝对（相对 .chery 目录）。
  // spawn sense 存 metadata.systemPromptFile（绝对），buildFirstSystemPrompt 实时读取；
  // 预设 leader 编制取 config.roles[leader]，其 systemPrompt 在此统一解析，预设无需再单独补全。
  if (config.roles) {
    for (const cfg of Object.values(config.roles)) {
      if (cfg.systemPrompt && !path.isAbsolute(cfg.systemPrompt)) {
        cfg.systemPrompt = path.join(context.cheryDir, '.chery', cfg.systemPrompt)
      }
    }
  }

  // brain.thinking 归一化为 ThinkingLevel（legacy boolean → level；非法 → "off"）。
  // 运行时 ctx.runtime.brain.thinking 必为 level，provider 据 level 映射请求参数。
  if (config.llm?.brain) {
    for (const cfg of Object.values(config.llm.brain)) {
      cfg.thinking = normalizeBrainThinking(cfg.thinking)
    }
  }

  // 自动补全 .chery 目录路径
  config.global.skills_dir = path.join(context.cheryDir, '.chery', 'skills')
  config.global.plugins_dir = path.join(context.cheryDir, '.chery', 'plugins')
  config.global.senses_dir = path.join(context.cheryDir, '.chery', 'senses')
  config.global.prompts_dir = path.join(context.cheryDir, '.chery', 'prompt')
  config.global.db_dir = context.dbDir ?? path.join(context.cheryDir, '.chery', 'db')
  config.global.memory_dir = path.join(context.cheryDir, '.chery', 'memory')
  config.global.rule_dir = path.join(context.cheryDir, '.chery', 'rule')

  // 断连宽限期默认值：15000ms（与 .chery.template 同步；缺省 15s）
  config.global.disconnect_grace_ms =
    config.global.disconnect_grace_ms !== undefined ? config.global.disconnect_grace_ms : 15000

  // 审批业务截止时间默认值：300000ms（5min）。0 仍显式表示不设业务截止时间。
  config.global.approval_timeout =
    config.global.approval_timeout !== undefined ? config.global.approval_timeout : 300000

  // 审批 runtime 资源上限默认值：1800000ms（30min；approval_timeout=0 时生效，与 .chery.template 同步）
  config.global.approval_hard_timeout =
    config.global.approval_hard_timeout !== undefined
      ? config.global.approval_hard_timeout
      : 1800000

  // 项目记忆配置默认值（缺省 → global{30,500} · workspace{15,500}）
  config.memory = {
    global: {
      max_count: config.memory?.global?.max_count ?? 30,
      max_chars: config.memory?.global?.max_chars ?? 500,
    },
    workspace: {
      max_count: config.memory?.workspace?.max_count ?? 15,
      max_chars: config.memory?.workspace?.max_chars ?? 500,
    },
  }

  // 命令系统配置默认值（缺省 → warn=60%, auto=80%, min=32000, safety=1024）
  config.global.command = {
    warn: config.global.command?.warn ?? DEFAULT_COMMAND_CONFIG.warn,
    auto: config.global.command?.auto ?? DEFAULT_COMMAND_CONFIG.auto,
    min_context_limit:
      config.global.command?.min_context_limit ?? DEFAULT_COMMAND_CONFIG.min_context_limit,
    safety_margin: config.global.command?.safety_margin ?? DEFAULT_COMMAND_CONFIG.safety_margin,
  }

  // history_recall 感官输出上限默认值：4000 字符（与 .chery.template 同步）
  config.global.history_recall = {
    max_output_chars: config.global.history_recall?.max_output_chars ?? 4000,
  }

  // 服务配置默认值兜底（端口 + 传输格式；web_port 已废弃，HTTP 端口改 server.webPort，
  // 优先级 WEB_PORT 环境变量 > server.webPort > 默认 8183）
  const serverRaw = context.server ?? config.server
  config.server = {
    port: serverRaw?.port ?? 8182,
    webPort: Number(context.webPort ?? serverRaw?.webPort ?? 8183),
    transport: serverRaw?.transport === 'json' ? 'json' : 'binary',
    host: serverRaw?.host ?? '127.0.0.1',
    // 默认托管前端 SPA：仅在 dev/prod 产物存在时实际生效；缺失时日志警告并退化为仅 API
    serve_frontend: serverRaw?.serve_frontend !== false,
    static_dir_override: serverRaw?.static_dir_override,
    auth: serverRaw?.auth,
    remote: serverRaw?.remote
      ? {
          enabled: serverRaw.remote.enabled === true,
          httpPort: serverRaw.remote.httpPort ?? 0,
          websocketPort: serverRaw.remote.websocketPort ?? 0,
        }
      : undefined,
    workspace_browse: serverRaw?.workspace_browse,
  }

  return config
}

/** Disk parsing has no startup policy: callers receive errors instead of exiting. */
export function readRuntimeConfigSource(cheryDir: string): RuntimeConfigSource {
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  return yaml.load(fs.readFileSync(configPath, 'utf8')) as RuntimeConfigSource
}

function readStartupConfigSource(): RuntimeConfigSource {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  try {
    return readRuntimeConfigSource(cheryDir)
  } catch (error) {
    if (!fs.existsSync(configPath)) {
      console.error(`✗ 配置文件不存在: ${configPath}`)
      console.error(`  请确认 CHERY_DIR 环境变量指向正确的项目根目录（当前: ${cheryDir}）`)
      process.exit(1)
    }
    throw error
  }
}

const startupSource = readStartupConfigSource()
const runtimeContext: Omit<RuntimeConfigNormalizationContext, 'environment'> = {
  cheryDir: process.env.CHERY_DIR || process.cwd(),
  dbDir: process.env.DB_DIR,
  webPort: process.env.WEB_PORT,
  server: structuredClone(startupSource.server),
}
if (!process.env.CHERY_DIR) {
  console.warn(`⚠️ 环境变量 CHERY_DIR 未配置，使用默认路径: ${runtimeContext.cheryDir}`)
}
const startupEnvironment = readRuntimeEnvironment()
const startupMissingEnvVars = new Set<string>()
collectEnvPlaceholders(startupSource, startupMissingEnvVars)
const unresolvedStartupEnvVars = [...startupMissingEnvVars].filter(
  (name) => !startupEnvironment[name],
)
if (unresolvedStartupEnvVars.length > 0) {
  console.warn(`⚠️ 环境变量未配置: ${unresolvedStartupEnvVars.join(', ')}`)
}
const initialConfig = normalizeRuntimeConfig(startupSource, {
  ...runtimeContext,
  environment: startupEnvironment,
})
runtimeContext.server = structuredClone(initialConfig.server)
const { server: _startupServer, ...initialRawConfig } = structuredClone(startupSource)
let appliedRawConfig = initialRawConfig
let appliedConfig = initialConfig

/** Build without publishing. Server/root/database values always come from startup context. */
export function prepareRuntimeConfig(raw: ConfigRaw): PreparedRuntimeConfig {
  const workspace = validateCandidateWorkspaces(raw)
  if (workspace.errors.length > 0) throw new Error(`配置校验失败:\n${workspace.errors.join('\n')}`)
  const source = structuredClone(raw)
  return {
    raw: source,
    config: normalizeRuntimeConfig(source, {
      ...runtimeContext,
      environment: readRuntimeEnvironment(),
    }),
  }
}

export function createRuntimeConfigCandidate(raw: ConfigRaw): Config {
  return prepareRuntimeConfig(raw).config
}

export function getAppliedRawConfig(): ConfigRaw {
  return structuredClone(appliedRawConfig)
}

/** A run owns this reference; later publications replace instead of mutating it. */
export function captureRuntimeConfig(): Config {
  return appliedConfig
}

export function getRuntimeConfig(): Config {
  return appliedConfig
}

/** Publish an already prepared pair; parsing and validation cannot fail here. */
export function publishRuntimeConfig(candidate: PreparedRuntimeConfig): Config {
  appliedRawConfig = structuredClone(candidate.raw)
  appliedConfig = candidate.config
  return appliedConfig
}

/** Normalize first; a failed candidate cannot change the published object. */
export function replaceRuntimeConfig(raw: ConfigRaw): Config {
  return publishRuntimeConfig(prepareRuntimeConfig(raw))
}

/** Re-resolve retained placeholders after process.env has been rotated. */
export function refreshRuntimeConfigEnvironment(): Config {
  return replaceRuntimeConfig(appliedRawConfig)
}

// Compatibility view for consumers migrated in later chapters. Nested values are
// resolved against the latest published object; no existing object is mutated on swap.
const config = new Proxy({} as Config, {
  get: (_target, property) => Reflect.get(appliedConfig, property),
  set: (_target, property, value) => Reflect.set(appliedConfig, property, value),
  has: (_target, property) => Reflect.has(appliedConfig, property),
  ownKeys: () => Reflect.ownKeys(appliedConfig),
  getOwnPropertyDescriptor: (_target, property) => {
    const descriptor = Reflect.getOwnPropertyDescriptor(appliedConfig, property)
    return descriptor ? { ...descriptor, configurable: true } : undefined
  },
})

/**
 * 重读 .chery/config.yaml 的 mcp_servers 段，跑 replaceEnvVars + supervision 解析，
 * 原地替换 config.mcp_servers。供 mcp.reload 在运行期拾取配置变更。
 *
 * 作用域：仅 mcp_servers。其他配置段（global/sense_groups/llm）不重读——
 * 全量配置热更属另一特性。
 *
 * 安全性：仅 core/mcp/loader 读取 config.mcp_servers（已确认），替换引用不影响其他模块。
 */
export function reloadMcpServersConfig(): Record<string, McpServerConfig> | undefined {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  if (!fs.existsSync(configPath)) return config.mcp_servers

  const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as {
    mcp_servers?: Record<string, McpServerConfig>
  }
  const rawServers = raw.mcp_servers
  if (!rawServers) {
    config.mcp_servers = undefined
    return undefined
  }

  const replaced = replaceEnvVars(rawServers) as Record<string, McpServerConfig>
  for (const serverCfg of Object.values(replaced)) {
    if (typeof serverCfg.supervision === 'string') {
      serverCfg.supervision =
        SupervisionLevel[serverCfg.supervision as keyof typeof SupervisionLevel]
    }
  }

  config.mcp_servers = replaced
  return replaced
}

const VALID_SUPERVISION = ['auto', 'smart', 'manual'] as const
type SupervisionName = (typeof VALID_SUPERVISION)[number]

function isSupervisionName(v: unknown): v is SupervisionName {
  return v === 'auto' || v === 'smart' || v === 'manual'
}

/**
 * 业务校验原始配置（raw 形态：supervision 为字符串、未补全路径、key 仍为 $ENV）。
 * 返回错误字符串数组（空 = 通过）。loadConfig 启动期与 config.save RPC 共用。
 *
 * workspace 路径不在此校验：启动期不关心（workspace 是环境配置非服务必需），
 * 保存期由 saveRawConfig 单独校验（errors/warnings 分离）。
 *
 * supervision 值必须显式校验，非法字符串不得静默转为undefined；
 * 本函数显式校验 supervision 合法值，fail loud（规则12）。
 */
export function validateRawConfig(raw: ConfigRaw): string[] {
  const errors: string[] = []

  // supervision 合法值（global + mcp_servers）
  const gsup = raw.global?.supervision
  if (!isSupervisionName(gsup)) {
    errors.push(`global.supervision "${String(gsup)}" 非法（合法：auto/smart/manual）`)
  }
  if (raw.mcp_servers) {
    for (const [name, cfg] of Object.entries(raw.mcp_servers)) {
      const sup = cfg?.supervision
      if (sup !== undefined && !isSupervisionName(sup)) {
        errors.push(
          `mcp_servers.${name}.supervision "${String(sup)}" 非法（合法：auto/smart/manual）`,
        )
      }
    }
  }

  // manager 段（本地管理器监听，server 侧专属）：host 可选字符串
  if (raw.manager?.host !== undefined && typeof raw.manager.host !== 'string') {
    errors.push('manager.host 必须是字符串')
  }

  // sense_groups 的 :level 后缀合法
  if (raw.sense_groups) {
    for (const [group, senses] of Object.entries(raw.sense_groups)) {
      for (const entry of senses ?? []) {
        const idx = entry.indexOf(':')
        if (idx >= 0) {
          const level = entry.slice(idx + 1)
          if (!isSupervisionName(level)) {
            errors.push(
              `sense_groups.${group} 的 "${entry}" :level 后缀非法（合法：auto/smart/manual）`,
            )
          }
        }
      }
    }
  }

  // llm.brain.* model/provider 必填
  const brainEntries = Object.entries(raw.llm?.brain ?? {})
  if (brainEntries.length === 0) {
    errors.push('llm.brain 不能为空（至少配置一颗大脑）')
  }
  const brainNames = brainEntries.map(([n]) => n)
  for (const [name, cfg] of brainEntries) {
    if (!cfg?.model) errors.push(`llm.brain.${name}.model 必填`)
    if (!cfg?.provider) errors.push(`llm.brain.${name}.provider 必填`)
    if (cfg?.protocol !== undefined && !isLlmProtocol(cfg.protocol)) {
      errors.push(`llm.brain.${name}.protocol 不受支持：${String(cfg.protocol)}`)
    }
    if (cfg?.protocol && cfg?.provider) {
      const providerDefinition = findLlmProviderDefinition(cfg.provider)
      if (providerDefinition && !providerDefinition.protocols.includes(cfg.protocol)) {
        errors.push(`llm.brain.${name}.provider(${cfg.provider}) 不支持 protocol(${cfg.protocol})`)
      }
    }
    // thinking：接受 legacy boolean（true/false）或任意非空字符串显示词（由 model-catalog wire 翻译）；非法 fail loud
    // cfg.thinking 类型已为 ThinkingLevel，运行时值可能是 legacy boolean/字符串，用 unknown 比较避开类型冲突
    const t = cfg?.thinking as unknown
    if (
      t !== undefined &&
      t !== true &&
      t !== false &&
      !(typeof t === 'string' && t.trim() !== '')
    ) {
      errors.push(`llm.brain.${name}.thinking 非法（合法：true/false 或任意非空显示词）`)
    }
    if (
      cfg?.capabilities?.generate &&
      cfg.capabilities.toolCall === false &&
      Object.values(cfg.capabilities.generate).some(Boolean)
    ) {
      errors.push(`llm.brain.${name}.capabilities.generate 需要 Tool Call 能力`)
    }
  }

  // roles.*.brain 必须存在于 llm.brain；roles.*.systemPrompt 文件存在性（相对 .chery 目录解析；绝对路径原样）。
  if (raw.roles) {
    const cheryDir = process.env.CHERY_DIR || process.cwd()
    const roleNameById = new Map<string, string>()
    for (const [name, cfg] of Object.entries(raw.roles)) {
      if (cfg.id !== undefined && !/^role-[a-zA-Z0-9_-]{8,}$/.test(cfg.id)) {
        errors.push(`roles.${name}.id 非法（必须以 role- 开头且至少包含 8 位标识）`)
      } else if (cfg.id !== undefined) {
        const duplicate = roleNameById.get(cfg.id)
        if (duplicate) errors.push(`roles.${name}.id 与 roles.${duplicate}.id 重复：${cfg.id}`)
        else roleNameById.set(cfg.id, name)
      }
      if (cfg.kind !== undefined && cfg.kind !== 'role' && cfg.kind !== 'shadow') {
        errors.push(`roles.${name}.kind "${String(cfg.kind)}" 非法（合法：role/shadow）`)
      }
      if (cfg.kind === 'shadow' && cfg.mentionable === true) {
        errors.push(`roles.${name} 是 Shadow，不能配置 mentionable:true`)
      }
      if (!brainNames.includes(cfg.brain)) {
        errors.push(
          `roles.${name}.brain "${cfg.brain}" 不在 llm.brain 列表（可用：${brainNames.join(', ')})`,
        )
      }
      const brain = raw.llm?.brain?.[cfg.brain]
      if (brain?.capabilities?.toolCall === false && (cfg.senseGroup || cfg.mcpServers?.length)) {
        errors.push(
          `roles.${name} 使用不支持 Tool Call 的 brain 时不能配置 senseGroup 或 mcpServers`,
        )
      }
      if (cfg.systemPrompt) {
        const p = path.isAbsolute(cfg.systemPrompt)
          ? cfg.systemPrompt
          : path.join(cheryDir, '.chery', cfg.systemPrompt)
        if (!fs.existsSync(p)) {
          errors.push(`roles.${name}.systemPrompt 文件不存在: ${cfg.systemPrompt}（解析: ${p}）`)
        }
      }
      if (cfg.avatar) {
        const avatarError = validateRoleAvatar(cfg.avatar)
        if (avatarError) errors.push(`roles.${name}.avatar ${avatarError}`)
      }
    }
  }

  // 预设：leader 必填、必须 ∈ config.roles 且 ∈ 该预设 roles 列表；roles[*] 引用的 type 必存在于 config.roles。
  // 主 pet 编制取 leader 角色的 RoleConfig（brain/senseGroup/mcp/systemPrompt），故 leader 合法性即 main 编制合法性。
  if (raw.presets) {
    const roleNames = Object.keys(raw.roles ?? {})
    const ordinaryRoleNames = roleNames.filter((name) => isOrdinaryRole(raw.roles?.[name]))
    const shadowRoleNames = roleNames.filter((name) => isShadowRole(raw.roles?.[name]))
    const presetNameById = new Map<string, string>()
    for (const [pname, pcfg] of Object.entries(raw.presets)) {
      if (pcfg.id !== undefined && !/^preset-[a-zA-Z0-9_-]{8,}$/.test(pcfg.id)) {
        errors.push(`presets.${pname}.id 非法（必须以 preset- 开头且至少包含 8 位标识）`)
      } else if (pcfg.id !== undefined) {
        const duplicate = presetNameById.get(pcfg.id)
        if (duplicate)
          errors.push(`presets.${pname}.id 与 presets.${duplicate}.id 重复：${pcfg.id}`)
        else presetNameById.set(pcfg.id, pname)
      }
      const members = pcfg?.roles ?? []
      if (pcfg.detailRole && !ordinaryRoleNames.includes(pcfg.detailRole)) {
        errors.push(`presets.${pname}.detailRole "${pcfg.detailRole}" 必须引用普通角色`)
      } else if (pcfg.detailRole && !members.includes(pcfg.detailRole)) {
        errors.push(`presets.${pname}.detailRole "${pcfg.detailRole}" 不在其 roles 成员列表中`)
      } else if (pcfg.detailRole && pcfg.detailRole === pcfg.leader) {
        errors.push(`presets.${pname}.detailRole 不能与 leader 使用同一角色`)
      }
      if (!pcfg?.leader) {
        errors.push(`presets.${pname}.leader 必填（组长角色）`)
      } else if (!ordinaryRoleNames.includes(pcfg.leader)) {
        errors.push(
          `presets.${pname}.leader "${pcfg.leader}" 必须引用普通角色（可用：${ordinaryRoleNames.join(', ') || '（未配置任何普通角色）'}）`,
        )
      } else if (!members.includes(pcfg.leader)) {
        errors.push(`presets.${pname}.leader "${pcfg.leader}" 不在其 roles 成员列表中`)
      } else if (raw.roles?.[pcfg.leader]?.scope === 'public') {
        errors.push(
          `presets.${pname}.leader "${pcfg.leader}" 不能是公共角色（组长必须是本预设的私有角色）`,
        )
      }
      // roles 成员为 type 名引用（string[]），每个必须存在于 config.roles
      for (const type of members) {
        if (!ordinaryRoleNames.includes(type)) {
          errors.push(
            `presets.${pname}.roles 只能引用普通角色，收到 "${type}"（可用：${ordinaryRoleNames.join(', ') || '（未配置任何普通角色）'}）`,
          )
        }
      }
      const routingShadow = pcfg.shadows?.conversationRouting
      if (routingShadow) {
        if (!shadowRoleNames.includes(routingShadow)) {
          errors.push(
            `presets.${pname}.shadows.conversationRouting "${routingShadow}" 必须引用 Shadow（可用：${shadowRoleNames.join(', ') || '（未配置任何 Shadow）'}）`,
          )
        } else {
          const shadow = raw.roles?.[routingShadow]
          const senses = raw.sense_groups?.[shadow?.senseGroup ?? ''] ?? []
          if (
            senses.length !== 1 ||
            (senses[0] !== 'select_conversation' && senses[0] !== 'select_conversation:auto')
          ) {
            errors.push(
              `会话路由 Shadow "${routingShadow}" 的 senseGroup 必须且只能包含 select_conversation:auto`,
            )
          }
          if ((shadow?.mcpServers?.length ?? 0) > 0) {
            errors.push(`会话路由 Shadow "${routingShadow}" 不能配置 MCP server`)
          }
        }
      }
      // workspace 不在此校验：启动期不关心（workspace 是环境配置非服务必需）；
      // 保存期由 saveRawConfig 单独校验（errors/warnings 分离）。

      // schedule 定时触发器：cron 非空字符串、task 非空、enabled boolean
      const sched = pcfg?.schedule
      if (sched) {
        if (typeof sched.cron !== 'string' || sched.cron.trim() === '') {
          errors.push(`presets.${pname}.schedule.cron 不能为空`)
        }
        if (typeof sched.task !== 'string' || sched.task.trim() === '') {
          errors.push(`presets.${pname}.schedule.task 不能为空`)
        }
        if (sched.enabled !== undefined && typeof sched.enabled !== 'boolean') {
          errors.push(
            `presets.${pname}.schedule.enabled 必须为 boolean（当前：${String(sched.enabled)}）`,
          )
        }
      }
    }
  }

  // 项目记忆：每层 max_count > 0, max_chars > 0（正整数）。
  // undefined 视为「沿用默认」（设面板 GlobalTab 占位未填的常见情况），不阻断落盘。
  if (raw.memory) {
    for (const layer of ['global', 'workspace'] as const) {
      const limits = raw.memory[layer]
      if (!limits) continue
      if (
        limits.max_count !== undefined &&
        (typeof limits.max_count !== 'number' || limits.max_count < 1)
      ) {
        errors.push(`memory.${layer}.max_count 必须为正整数（当前：${String(limits.max_count)}）`)
      }
      if (
        limits.max_chars !== undefined &&
        (typeof limits.max_chars !== 'number' || limits.max_chars < 1)
      ) {
        errors.push(`memory.${layer}.max_chars 必须为正整数（当前：${String(limits.max_chars)}）`)
      }
    }
  }

  // approval_timeout：≥ 0，0 = 不限时（与 core createApproval 的 `> 0` guard 对齐）
  if (raw.global?.approval_timeout !== undefined) {
    const t = raw.global.approval_timeout
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      errors.push(`global.approval_timeout 必须为 ≥ 0 的数字（0 = 不超时，当前：${String(t)}）`)
    }
  }

  if (raw.global?.llm_request_timeout_ms !== undefined) {
    const t = raw.global.llm_request_timeout_ms
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      errors.push(
        `global.llm_request_timeout_ms 必须为 ≥ 0 的有限数字（0 = 不限制，当前：${String(t)}）`,
      )
    }
  }

  // approval_hard_timeout：≥ 0（审批 runtime 资源上限，approval_timeout=0 时生效）
  if (raw.global?.approval_hard_timeout !== undefined) {
    const h = raw.global.approval_hard_timeout
    if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) {
      errors.push(`global.approval_hard_timeout 必须为 ≥ 0 的数字（当前：${String(h)}）`)
    }
  }

  // disconnect_grace_ms：≥ 0 有限毫秒（断连宽限期）
  if (raw.global?.disconnect_grace_ms !== undefined) {
    const g = raw.global.disconnect_grace_ms
    if (typeof g !== 'number' || !Number.isFinite(g) || g < 0) {
      errors.push(`global.disconnect_grace_ms 必须为 ≥ 0 的数字（0 = 不等待，当前：${String(g)}）`)
    }
  }

  // history_recall：max_output_chars > 0（感官单次返回硬字符上限）
  if (raw.global?.history_recall?.max_output_chars !== undefined) {
    const m = raw.global.history_recall.max_output_chars
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
      errors.push(`global.history_recall.max_output_chars 必须为 > 0 的数字（当前：${String(m)}）`)
    }
  }

  // watchdog：timeout_ms ≥ 0，wake_on_timeout boolean（子 agent feed-dog 看门狗）
  if (raw.global?.watchdog !== undefined) {
    const wd = raw.global.watchdog
    if (typeof wd !== 'object' || wd === null) {
      errors.push(`global.watchdog 必须为对象（当前：${String(wd)}）`)
    } else {
      const w = wd as { timeout_ms?: unknown; wake_on_timeout?: unknown }
      if (
        w.timeout_ms !== undefined &&
        (typeof w.timeout_ms !== 'number' || !Number.isFinite(w.timeout_ms) || w.timeout_ms < 0)
      ) {
        errors.push(`global.watchdog.timeout_ms 必须为 ≥ 0 的数字（当前：${String(w.timeout_ms)}）`)
      }
      if (w.wake_on_timeout !== undefined && typeof w.wake_on_timeout !== 'boolean') {
        errors.push(
          `global.watchdog.wake_on_timeout 必须为 boolean（当前：${String(w.wake_on_timeout)}）`,
        )
      }
    }
  }

  // tree_full_render_threshold：≥ 0（节点树全量渲染阈值，0 = 始终裁剪）
  if (raw.global?.tree_full_render_threshold !== undefined) {
    const t = raw.global.tree_full_render_threshold
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      errors.push(
        `global.tree_full_render_threshold 必须为 ≥ 0 的数字（0 = 始终裁剪，当前：${String(t)}）`,
      )
    }
  }

  // command 配置：warn/auto 为 Threshold{unit,value}；min_context_limit / safety_margin ≥ 0
  if (raw.global?.command) {
    const cmd = raw.global.command
    const thresholdError = (label: string, t: unknown): string | null => {
      if (t === undefined) return null
      if (typeof t !== 'object' || t === null) {
        return `${label} 必须为 { unit: "tokens"|"percent"; value: number }（当前：${String(t)}）`
      }
      const tt = t as { unit?: unknown; value?: unknown }
      if (tt.unit !== 'tokens' && tt.unit !== 'percent') {
        return `${label}.unit 必须为 "tokens"|"percent"（当前：${String(tt.unit)}）`
      }
      if (typeof tt.value !== 'number' || !Number.isFinite(tt.value) || tt.value < 0) {
        return `${label}.value 必须为 ≥ 0 的数字（当前：${String(tt.value)}）`
      }
      if (tt.unit === 'percent' && tt.value > 1) {
        return `${label}.value 百分比单位必须在 [0,1]（当前：${String(tt.value)}）`
      }
      return null
    }
    const warnErr = thresholdError('global.command.warn', cmd.warn)
    if (warnErr) errors.push(warnErr)
    const autoErr = thresholdError('global.command.auto', cmd.auto)
    if (autoErr) errors.push(autoErr)
    if (
      cmd.min_context_limit !== undefined &&
      (typeof cmd.min_context_limit !== 'number' ||
        !Number.isFinite(cmd.min_context_limit) ||
        cmd.min_context_limit < 0)
    ) {
      errors.push(
        `global.command.min_context_limit 必须为 ≥ 0 的数字（当前：${String(cmd.min_context_limit)}）`,
      )
    }
    if (
      cmd.safety_margin !== undefined &&
      (typeof cmd.safety_margin !== 'number' ||
        !Number.isFinite(cmd.safety_margin) ||
        cmd.safety_margin < 0)
    ) {
      errors.push(
        `global.command.safety_margin 必须为 ≥ 0 的数字（当前：${String(cmd.safety_margin)}）`,
      )
    }
  }

  return errors
}

/**
 * 密钥字段中的 `$ENV` 必须使用统一的全大写占位符格式。
 *
 * 此项故意不并入 validateRawConfig：旧配置在启动时仍可加载，实际调用会给出
 * 可操作的运行期提示；但所有新的保存、预检与回滚都必须阻止该错误重新落盘。
 */
function validateCredentialEnvPlaceholders(raw: unknown): string[] {
  // 兼容历史备份：rollbackConfig 过去允许注释/空 YAML 原样恢复；只有对象配置才检查密钥字段。
  const config = raw !== null && typeof raw === 'object' ? (raw as ConfigRaw) : undefined
  const errors: string[] = []
  for (const [name, cfg] of Object.entries(config?.llm?.brain ?? {})) {
    if (isMalformedEnvPlaceholder(cfg?.key)) {
      errors.push(envPlaceholderFormatError(`llm.brain.${name}.key`))
    }
  }
  return errors
}

/**
 * 在后端主机上校验预设 workspace。空值代表「未限定」，视为有效。
 * 仅做文件系统检查，不读取或写入 config.yaml；设置页的即时校验与 saveRawConfig 复用此规则。
 */
export function validateWorkspacePath(workspace: string | undefined): {
  valid: boolean
  error?: string
} {
  if (!workspace) return { valid: true }
  if (!path.isAbsolute(workspace)) return { valid: false, error: '必须是绝对路径' }
  try {
    const stat = fs.statSync(workspace)
    if (!stat.isDirectory()) return { valid: false, error: '必须是目录' }
    fs.accessSync(workspace)
    return { valid: true }
  } catch {
    return { valid: false, error: '目录不存在或不可访问' }
  }
}

/**
 * 读 .chery/config.yaml 原文（供 config.get）。
 * 不 replaceEnvVars（key 保持 $ENV 占位符）、不补全路径、不转 supervision 枚举；剥离 server 段。
 */
export function readRawConfig(): ConfigRaw {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as ConfigRaw & {
    server?: unknown
    manager?: unknown
    /** 已退役的媒体网关配置；读取时丢弃，避免旧配置污染 config.get 响应。 */
    media?: unknown
  }
  // 端口/传输、管理器监听和已退役的媒体网关不通过面板编辑，读取时剥离。
  const { server: _server, manager: _manager, media: _media, ...rest } = raw
  void _server
  void _manager
  void _media
  ensurePresetIds(rest.presets)
  ensureRoleIds(rest.roles)
  // routingBrain 已废弃；读取设置时主动剥离，下一次保存自然从磁盘删除。
  for (const preset of Object.values(rest.presets ?? {})) {
    delete (preset as PresetConfig & { routingBrain?: string }).routingBrain
  }
  // brain.thinking 归一化为 ThinkingLevel（前端 config.get 拿到的就是 level，无需再处理 legacy boolean）
  if (rest.llm?.brain) {
    for (const cfg of Object.values(rest.llm.brain)) {
      cfg.thinking = normalizeBrainThinking(cfg.thinking)
    }
  }
  return rest
}

/**
 * 配置敏感字段脱敏（供 config_manage get 返回 / 前端 config.get 前过滤）。
 * 规则（对照 docs/backend/agent/config-manage.md「敏感字段脱敏」）：
 *  - `$ENV` 占位符（/^\$[A-Z_][A-Z0-9_]*$/）原样保留——运行时由 replaceEnvVars 注入，占位符本身非敏感。
 *  - `llm.brain.*.key` / `media.*.key`：非 $ENV 明文 → `[REDACTED]`。
 *  - `mcp_servers.*.env`：每个值非 $ENV → `[REDACTED]`。
 *  - `mcp_servers.*.url`：内联凭证（scheme://user:pass@host）→ 凭证段 `[REDACTED]`（url 其余保留）。
 * 深拷贝返回，不改入参。
 */
function redactSecretValue(value: string): string {
  return ENV_PLACEHOLDER_RE.test(value) ? value : '[REDACTED]'
}

function redactUrlSecret(url: string): string {
  // scheme://user:pass@host 或 scheme://token@host → 凭证段替换；无凭证则原样
  const m = /^(https?:\/\/)[^/@]+@/.exec(url)
  return m ? `${m[1]}[REDACTED]@${url.slice(m[0].length)}` : url
}

export function redactConfigSecrets(raw: ConfigRaw): ConfigRaw {
  const copy = structuredClone(raw)
  if (copy.llm?.brain) {
    for (const cfg of Object.values(copy.llm.brain)) {
      if (cfg.key !== undefined) cfg.key = redactSecretValue(cfg.key)
    }
  }
  if (copy.mcp_servers) {
    for (const srv of Object.values(copy.mcp_servers)) {
      if (srv.env) {
        for (const k of Object.keys(srv.env)) {
          const v = srv.env[k]
          if (v !== undefined) srv.env[k] = redactSecretValue(v)
        }
      }
      if (typeof srv.url === 'string') srv.url = redactUrlSecret(srv.url)
    }
  }
  return copy
}

/**
 * 配置敏感字段还原（供 config_manage patch / 前端 config.save 落盘前）。
 * 把候选中值为 `[REDACTED]` 的敏感字段替换为盘上（disk）原值——模型 get → patch 目标资源时
 * 携带 [REDACTED] 不会覆盖真实 key；若显式给出新明文（非 [REDACTED]）则以新值为准。
 * 深拷贝返回，不改入参。
 */
function restoreUrlSecret(partialUrl: string, diskUrl: string): string {
  return partialUrl.includes('[REDACTED]@') ? diskUrl : partialUrl
}

export function restoreRedactedSecrets(partial: ConfigRaw, disk: ConfigRaw): ConfigRaw {
  const copy = structuredClone(partial)
  if (copy.llm?.brain && disk.llm?.brain) {
    for (const [name, cfg] of Object.entries(copy.llm.brain)) {
      const diskCfg = disk.llm.brain[name]
      if (cfg.key === '[REDACTED]' && diskCfg?.key !== undefined) cfg.key = diskCfg.key
    }
  }
  if (copy.mcp_servers && disk.mcp_servers) {
    for (const [name, srv] of Object.entries(copy.mcp_servers)) {
      const diskSrv = disk.mcp_servers[name]
      if (srv.env && diskSrv?.env) {
        for (const k of Object.keys(srv.env)) {
          if (srv.env[k] === '[REDACTED]' && diskSrv.env[k] !== undefined)
            srv.env[k] = diskSrv.env[k]
        }
      }
      if (typeof srv.url === 'string' && typeof diskSrv?.url === 'string') {
        srv.url = restoreUrlSecret(srv.url, diskSrv.url)
      }
    }
  }
  return copy
}
export const BACKUP_KEEP = 10

export function backupConfig(configPath: string): string {
  const backupsDir = path.join(path.dirname(configPath), 'backups')
  fs.mkdirSync(backupsDir, { recursive: true })
  const now = new Date()
  const stamp =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
    `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const dest = path.join(backupsDir, `config-${stamp}.yaml`)
  fs.copyFileSync(configPath, dest)
  // 保留最近 BACKUP_KEEP 份（文件名定宽前缀 → 字典序 = 时间序）
  const files = fs
    .readdirSync(backupsDir)
    .filter((f) => /^config-\d{8}-\d{6}\.yaml$/.test(f))
    .sort()
  while (files.length > BACKUP_KEEP) {
    const oldest = files.shift()
    if (oldest) fs.rmSync(path.join(backupsDir, oldest), { force: true })
  }
  return dest
}

/**
 * 列出 .chery/backups/ 下的配置备份（按时间倒序，最近在前）。供 config_manage(action="get") 展示回滚点。
 */
export function listConfigBackups(): string[] {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const backupsDir = path.join(cheryDir, '.chery', 'backups')
  if (!fs.existsSync(backupsDir)) return []
  return fs
    .readdirSync(backupsDir)
    .filter((f) => /^config-\d{8}-\d{6}\.yaml$/.test(f))
    .sort()
    .reverse()
}

/**
 * 回滚配置：从 .chery/backups/ 恢复指定（或缺省最近）备份到 config.yaml。
 * 返回 { backup: 文件名 }；备份目录不存在时自愈创建（避免"目录不存在"误导性报错），为空时抛错。
 */
export function rollbackConfig(backupName?: string): { backup: string } {
  const { backup, path: backupPath } = readConfigBackup(backupName)
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  fs.copyFileSync(backupPath, configPath)
  return { backup }
}

/** Read a rollback point without mutating disk so callers can revision-check
 * and validate it through the normal commit path. */
export function readConfigBackup(backupName?: string): {
  backup: string
  raw: ConfigRaw
  path: string
} {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const backupsDir = path.join(cheryDir, '.chery', 'backups')
  // 自愈：确保备份目录存在；缺省回滚目标由候选备份决定。
  fs.mkdirSync(backupsDir, { recursive: true })
  const candidates = fs
    .readdirSync(backupsDir)
    .filter((f) => /^config-\d{8}-\d{6}\.yaml$/.test(f))
    .sort()
    .reverse()
  if (backupName && !candidates.includes(backupName)) {
    throw new Error(`回滚点不存在：${backupName}`)
  }
  const target = backupName ?? candidates[0]
  if (!target) throw new Error('备份目录为空，尚无可用备份（首次成功 action="patch" 后才会生成）')
  const targetPath = path.join(backupsDir, target)
  const backupRaw = yaml.load(fs.readFileSync(targetPath, 'utf8')) as ConfigRaw
  const errors = validateCredentialEnvPlaceholders(backupRaw)
  if (errors.length > 0) {
    throw new Error(`备份配置校验失败，未恢复：\n${errors.join('\n')}`)
  }
  const { server: _server, ...raw } = (backupRaw ?? {}) as ConfigRaw & { server?: unknown }
  return { backup: target, raw, path: targetPath }
}

/**
 * 校验 + 写回 .chery/config.yaml（供 config.save 与 config_manage 感官）。
 * 不碰运行时内存单例（重启生效）。失败 fail loud 返回 errors，不写盘。
 * 返回分离 errors（硬错误）+ warnings（软错误：workspace 路径无效），供 UI 分层展示。
 * workspace 路径校验仅在保存期做（启动期不关心 workspace 数据正确性）。
 * 写回保留盘上 server 段不动，js-yaml dump 无注释；字段说明见 .chery.template/docs/config.md。
 * 写盘前自动备份旧配置到 .chery/backups/（保留最近 10 份，见 backupConfig），出错可 rollbackConfig 回滚。
 */
export function saveRawConfig(
  partial: ConfigRaw,
): { ok: true } | { ok: false; errors: string[]; warnings: string[] } {
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  const disk = yaml.load(fs.readFileSync(configPath, 'utf8')) as ConfigRaw & {
    server?: ServerConfig
    manager?: unknown
  }
  const validation = validateConfigCandidate(partial, disk)
  if (!validation.ok) return validation

  // 落盘前补全缺失 id（前端新建角色未带 id；改名场景 value 对象随行携带 id，此处不覆盖）。
  ensurePresetIds(partial.presets)
  ensureRoleIds(partial.roles)
  // 写回保留盘上 server 与 manager 段不动（同 server 模式，manager 为 server 侧专属配置）。
  const merged = {
    ...partial,
    server: disk.server ?? { port: 8182, transport: 'binary' as const },
    ...(disk.manager ? { manager: disk.manager } : {}),
  }

  // 写盘前备份旧配置（.chery/backups/，保留最近 BACKUP_KEEP 份）——回滚到修改前状态的唯一依据。
  // 校验失败路径已提前 return，不会走到这里，故不会产生无效备份。
  backupConfig(configPath)
  fs.writeFileSync(configPath, yaml.dump(merged, { lineWidth: -1 }))
  return { ok: true }
}

/**
 * 完整校验一个尚未写盘的候选配置。
 *
 * 结构、凭证占位符、workspace、锁定角色和固定预设均在内存候选上完成；调用方可在
 * 校验通过后再决定是否持久化。`disk` 必须是本次写入所基于的磁盘快照，用于身份保护校验。
 */
export function validateConfigCandidate(
  candidate: ConfigRaw,
  disk: ConfigRaw = readRawConfig(),
): { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
  const errors = [...validateRawConfig(candidate), ...validateCredentialEnvPlaceholders(candidate)]
  const workspace = validateCandidateWorkspaces(candidate)
  errors.push(...workspace.errors)
  const warnings = workspace.warnings
  errors.push(...validateLockedRoleEdits(disk.roles, candidate.roles))
  errors.push(...validateFixedPresetEdits(disk.presets, candidate.presets))
  return errors.length > 0 || warnings.length > 0
    ? { ok: false, errors, warnings }
    : { ok: true, warnings }
}

/** Shared save/hot-apply workspace validation. Startup remains tolerant so a
 * stale optional project path cannot prevent the service from starting. */
function validateCandidateWorkspaces(candidate: ConfigRaw): {
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  if (candidate.presets) {
    for (const [pname, pcfg] of Object.entries(candidate.presets)) {
      const ws = pcfg?.workspace
      if (!ws) continue
      if (!path.isAbsolute(ws)) {
        errors.push(`presets.${pname}.workspace "${ws}" 必须是绝对路径`)
      } else {
        const validation = validateWorkspacePath(ws)
        if (!validation.valid)
          warnings.push(`presets.${pname}.workspace "${ws}" ${validation.error}`)
      }
    }
  }
  return { errors, warnings }
}

/**
 * 配置可加载性预检（供重启前 dry-run：避免坏配置 crash-loop 永不恢复）。
 * 模拟 loadConfig 的校验步骤，只检查不落地、不改 process.env、不 throw：
 *  1. validateRawConfig 全量业务校验（loadConfig 阶段 throw 的唯一来源，含 roles.*.systemPrompt
 *     文件存在性）→ 结构硬错误，阻塞重启（唯一硬错误来源）。
 *  2. `$ENV` 占位符指向缺失变量 → 软警告（不阻塞）。与启动期 loadConfig 一致只 warn——
 *     缺失 key 只影响运行期实际调用该 brain（assertChatOptions 抛用户可见的 llm.key.missing），
 *     不破坏配置结构；未使用的 brain key 缺失更不应卡住整个保存/重启流程。
 * 返回分离 errors（结构硬错误，阻塞重启）+ warnings（软告警：缺失环境变量等，仅提示）。
 */
export function validateLoadable(
  raw: ConfigRaw,
): { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] } {
  const copy = structuredClone(raw)
  // 1) 核心业务校验（loadConfig 阶段 throw 的唯一来源；systemPrompt 存在性在其内为硬错误）
  const errors = [...validateRawConfig(copy), ...validateCredentialEnvPlaceholders(copy)]
  // 2) $ENV 占位符缺失变量 → 软警告（占位符匹配规则与 replaceEnvVars 一致；不阻塞重启）
  const warnings: string[] = []
  const missing = new Set<string>()
  collectEnvPlaceholders(copy, missing)
  for (const name of missing) {
    if (!process.env[name]) warnings.push(`环境变量未配置: ${name}`)
  }
  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, warnings }
}

/** 递归收集对象中所有 `$ENV` 占位符指向的变量名（匹配 replaceEnvVars 的 /^\$([A-Z_][A-Z0-9_]*)$/）。 */
function collectEnvPlaceholders(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const m = value.match(/^\$([A-Z_][A-Z0-9_]*)$/)
    if (m?.[1]) out.add(m[1])
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEnvPlaceholders(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectEnvPlaceholders(v, out)
  }
}

/**
 * 读取 .env 文件中的变量名列表（供前端密钥下拉选择）。
 * 解析规则：每行 KEY=VALUE 或 KEY="VALUE"，忽略空行和 # 注释行。
 */
export function listEnvVarNames(): string[] {
  if (!fs.existsSync(rootEnvPath)) return []
  const content = fs.readFileSync(rootEnvPath, 'utf8')
  const names = new Set<string>()
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) names.add(key)
  }
  return [...names].sort()
}

/**
 * 读取 .env 文件 → key→value 映射（供 envGuard 值遮蔽）。
 * 用 dotenv.parse 纯解析：跳过空行/# 注释、值去引号。与 listEnvVarNames（仅取 key 名，供前端下拉）
 * 并存、互不派生——dotenv.parse 不做 /^[A-Za-z_][A-Za-z0-9_]*$/ 过滤，派生会改变下拉 key 集合。
 */
export function listEnvVarMap(): Record<string, string> {
  if (!fs.existsSync(rootEnvPath)) return {}
  return withoutDeploymentSecrets(dotenv.parse(fs.readFileSync(rootEnvPath, 'utf8')))
}

/**
 * 运行期按需重读 .env 文件，同步进 process.env（dotenv.config 只在模块加载时执行一次）。
 *  - override=false（默认）：只填充 process.env 缺失的键，不覆盖 OS env / 启动时已加载的值。
 *  - override=true：以 .env 为准覆盖既有值（用户明确「重载文件」意图，如点击密钥刷新）。
 * .env 不存在或不可读时静默忽略，保持现有 process.env。
 */
export interface EnvFileChanges {
  added: string[]
  changed: string[]
  removed: string[]
}

const RESTART_BOUND_ENV = new Set([
  'CHERY_ENV_FILE',
  'CHERY_DIR',
  'DB_DIR',
  'WEB_PORT',
  'CHERY_AUTH_SESSION_SECRET',
])

export function reloadEnvFile(override = false): EnvFileChanges {
  let parsed: Record<string, string> = {}
  try {
    parsed = withoutDeploymentSecrets(dotenv.parse(fs.readFileSync(rootEnvPath, 'utf8')))
  } catch {
    // A missing file means all values previously owned by it were removed.
  }
  return applyEnvFileSnapshot(parsed, override)
}

/** Reconcile one parsed .env snapshot with process.env. Exported so refresh
 * semantics can be verified without writing the host's real .env file. */
export function applyEnvFileSnapshot(
  parsed: Record<string, string>,
  override = false,
): EnvFileChanges {
  const added = Object.keys(parsed)
    .filter((key) => !(key in managedEnvFileValues))
    .sort()
  const changed = Object.keys(parsed)
    .filter((key) => key in managedEnvFileValues && parsed[key] !== managedEnvFileValues[key])
    .sort()
  const removed = Object.keys(managedEnvFileValues)
    .filter((key) => !(key in parsed))
    .sort()
  for (const [key, value] of Object.entries(parsed)) {
    if (RESTART_BOUND_ENV.has(key)) continue
    if (override || !(key in process.env)) process.env[key] = value
  }
  if (override) {
    for (const key of removed) {
      if (RESTART_BOUND_ENV.has(key)) continue
      const inherited = inheritedEnvironment[key]
      if (inherited === undefined) delete process.env[key]
      else process.env[key] = inherited
    }
  }
  managedEnvFileValues = parsed
  return { added, changed, removed }
}

/**
 * 获取 .chery 目录路径（从环境变量 CHERY_DIR 或默认 process.cwd()）。
 * 供 utils.openFile 等 handler 使用。
 */
export function getCheryDir(): string {
  return process.env.CHERY_DIR || process.cwd()
}


export default config
