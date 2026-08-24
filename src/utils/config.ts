import dotenv from 'dotenv'
import yaml from 'js-yaml'
import { validateFixedPresetEdits, validateLockedRoleEdits } from './lockedRole.js'
import fs from 'fs'
import path from 'path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'url'
import { SupervisionLevel } from '@/core/config'
import type { OAuth2Config } from '@/service/auth/index.js'
import type { ThinkingLevel } from '@/core/llm/adapter'
import { validateRoleAvatar } from '@/utils/roleAvatar.js'

// .env 路径：源码运行时 __dirname = src/utils/（需 ../..），打包产物 __dirname = dist/（需 ..）。
// dotenv.config() 不覆盖已存在的 process.env 变量，故开发/生产均可安全调用：
// 生产部署通常无 .env 文件，existsSync 短路；有 .env 时也只填充未设置的变量。
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isSourceRuntime = path.basename(path.dirname(__dirname)) === 'src'
const rootEnvPath = isSourceRuntime
  ? path.join(__dirname, '..', '..', '.env')
  : path.join(__dirname, '..', '.env')
if (fs.existsSync(rootEnvPath)) {
  dotenv.config({ path: rootEnvPath })
}

// 会话签名密钥持久化：确保 .chery/.env 存在 CHERY_AUTH_SESSION_SECRET，跨重启复用。
// 必须在 config.yaml 加载前注入 process.env，供 server.auth 鉴权（OAuth2Auth）读取。
ensureAuthSessionSecret()

/**
 * 生成/复用会话签名密钥（CHERY_AUTH_SESSION_SECRET），写入 .chery/.env 持久化。
 * - 进程环境已设置：直接复用，不改文件。
 * - .chery/.env 已含该键：读入注入进程环境。
 * - 否则生成 32 字节随机 hex 并追加写入。
 * 失效/轮换方案：删除 .chery/.env 中该行（或整文件）后重启，即重新生成新密钥，
 * 所有已签发 access/refresh token 立即失效（HMAC 验签失败），需重新登录。
 */
function ensureAuthSessionSecret(): void {
  if (process.env.CHERY_AUTH_SESSION_SECRET) return
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const envPath = path.join(cheryDir, '.chery', '.env')
  const envKey = 'CHERY_AUTH_SESSION_SECRET'
  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, 'utf8')
    const match = existing.match(new RegExp(`^${envKey}=(.*)$`, 'm'))
    if (match?.[1]) {
      process.env[envKey] = match[1]
      return
    }
  }
  const secret = randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(envPath), { recursive: true })
  fs.appendFileSync(envPath, `\n${envKey}=${secret}\n`)
  process.env[envKey] = secret
}

// 从 core 层重新导出 SupervisionLevel
export { SupervisionLevel } from '@/core/config'

/**
 * mock provider 脚本项（单次 LLM 调用的预定响应）
 * 用于离线测试 send/resume/revoke/loop 流程，不接真实 LLM。
 */
export interface MockScriptResponse {
  /** 思考增量 */
  thinking?: string
  /** 正文增量 */
  content?: string
  /** 工具调用（监管等级由 sense_groups 的 :level 决定，非脚本） */
  senseCalls?: { id?: string; name: string; arguments: string }[]
  /** 抛错（测 retry 中间件） */
  error?: string
  /** 每个 delta chunk 之间 sleep 毫秒（模拟流式节奏，刷新/重连测试用）；缺省取 brain.mock.chunkDelayMs */
  chunkDelayMs?: number
  /** 本轮首次响应前 sleep 毫秒（模拟首 token 延迟）；缺省取 brain.mock.preRespondMs */
  preRespondMs?: number
}

/**
 * mock 配置（brain 内）：只保留开关 + 脚本文件路径 + 全局延迟兜底。
 * 脚本内容（repeat + script[]）放独立文件，避免 config.yaml 过长。
 */
interface MockConfig {
  /** 开关：是否启用 mock（缺省 true） */
  enabled?: boolean
  /** 脚本文件路径，相对 .chery 目录（如 mock/read_file.yaml） */
  file: string
  /** 全局兜底：每个 delta chunk 之间 sleep 毫秒（脚本项缺省时取此，默认 0 不延迟） */
  chunkDelayMs?: number
  /** 全局兜底：本轮首次响应前 sleep 毫秒（脚本项缺省时取此，默认 0） */
  preRespondMs?: number
}

/** 模型声明的媒体能力。 */
export interface MediaCapabilities {
  image?: boolean
  video?: boolean
  audio?: boolean
}

/** 缺省兼容旧配置：toolCall=true，其余能力=false。 */
export interface BrainCapabilities {
  toolCall?: boolean
  input?: MediaCapabilities
  generate?: MediaCapabilities
}

/** 媒体类型 */
export type MediaKind = 'image' | 'video' | 'audio'

/** 命名媒体服务配置（独立实体，在 MediaTab 管理）。 */
export interface MediaServiceConfig {
  /** 服务类型（图/音/视） */
  type: MediaKind
  url: string
  model?: string
  key?: string
  enabled?: boolean
  /** 单文件上传上限（MiB），覆盖全局默认 100 */
  maxUploadMb?: number
}

/** 媒体服务集合：name → 配置。预设通过 PresetConfig.mediaImage/mediaVideo/mediaAudio 引用此处的 name。 */
export interface MediaConfig {
  [name: string]: MediaServiceConfig
}

/**
 * Brain 配置基础类型
 * 各 Provider 可扩展具体配置结构
 */
interface BrainConfig {
  url?: string
  model: string
  key?: string
  /** 思考强度档位（ThinkingLevel）：off=关闭，low/medium/high/xhigh=强度递增。legacy boolean 兼容（loadConfig/readRawConfig 归一）。 */
  thinking?: ThinkingLevel
  /** 表示这个大模型用什么适配的解析器 @/provider/xxx */
  provider: string
  /** 每分钟最大请求数（RPM）限额，provider 层滑动窗口限流，未配置则不限流 */
  rpm?: number
  /** true=URL 已含版本段（如 /v1），provider 只拼 endpoint 不自动补全；
   * 缺省 false=自动补全（无路径时补 /v1 等版本段）。规则见 docs/agent/provider.md「URL 解析与自动补全」。 */
  fullUrl?: boolean
  /** mock provider 专用：脚本化响应 */
  mock?: MockConfig
  /** 记忆容量（KB），供前端 context bar 显示用量（后端按 KB×256 折算 token 预算）。缺省兜底 */
  contextLimit?: number
  capabilities?: BrainCapabilities
  /** brain 级 hooks.json 路径（相对 .chery/），与全局 .chery/hooks/hooks.json 合并（brain 级在全局后追加） */
  hooks?: string
  /** Anthropic provider 兼容选项：3rd-party coding-plan 代理通常不实现 redacted_thinking。
   *  默认 false（safe strip）；真官方 Anthropic 用户置 true 启用完整协议。 */
  anthropicCompat?: {
    /** 是否官方 Anthropic API；true=完整扩展思考协议（保留 redacted_thinking 原样回传），
     *  false=strip redacted_thinking（兼容第三方 Anthropic 模式端点）。默认 false。 */
    official?: boolean
  }
}

/**
 * 把 brain.thinking 归一化为 ThinkingLevel。
 * - legacy boolean：true→"high"、false→"off"
 * - undefined/缺省 → "off"
 * - 已是合法 level → 原样
 * - 非法值 → "off"（兜底）
 *
 * 在 loadConfig（运行时）和 readRawConfig（RPC 读，前端拿到的就是 level）两处调用，
 * 保证 ctx.runtime.brain.thinking 与前端 DTO 都规范化。
 */
function normalizeBrainThinking(v: unknown, provider?: string): ThinkingLevel {
  if (v === true) return 'high'
  if (v === false || v === null) return 'off'
  if (v === undefined) return provider === 'deepseek' ? 'on' : 'off'
  if (v === 'off' || v === 'on' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh')
    return v
  return 'off'
}

interface LLMConfig {
  brain: Record<string, BrainConfig>
}

export type RolePermissionTemplate =
  | 'read-only'
  | 'workspace-developer'
  | 'supervised'
  | 'trusted'

export type RolePermissionEffect = 'inherit' | 'allow' | 'ask' | 'deny'
export type CommandRiskCategory =
  | 'filesystem'
  | 'destructive'
  | 'privilege'
  | 'system'
  | 'process'
  | 'network'
  | 'credential'
  | 'dynamic-code'
  | 'obfuscation'
  | 'unknown'

/**
 * 角色行为权限。senseGroup 决定「能看见哪些工具」，本策略决定「本次调用能否执行」。
 * allow 只表示本角色不额外收紧，不能绕过系统守卫、全局监管或语义风险判断。
 */
export interface RolePermissionPolicy {
  template: RolePermissionTemplate
  tools?: Record<string, RolePermissionEffect>
  filesystem?: {
    read?: 'deny' | 'workspace' | 'any'
    write?: 'deny' | 'workspace' | 'any-with-approval'
  }
  commands?: {
    shells?: Array<'bash' | 'powershell'>
    maxSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
    categories?: Partial<Record<CommandRiskCategory, RolePermissionEffect>>
  }
  mcp?: {
    default?: RolePermissionEffect
    tools?: Record<string, RolePermissionEffect>
  }
  spawn?: {
    allowedRoles?: string[]
    effect?: RolePermissionEffect
  }
}

/**
 * 角色配置（spawn_role sense 按 type 查这里；预设 leader 角色亦由此定义）。
 * 名 = 给 AI 的角色名；brain 必须存在于 llm.brain（loadConfig 校验）。
 * systemPrompt = 专属 system prompt 文件路径（相对 .chery 目录）；
 *   缺省 → 角色用全局 system_prompt。per-role system prompt（T7）。
 */
export interface RoleConfig {
  /**
   * 稳定身份 id（与 PresetConfig.id 同构）：DB（chat metadata.roleId）按 id 关联角色，
   * 改名必须保留本值。旧配置缺省时由 ensureRoleIds 按名字确定性生成（legacyRoleId）。
   */
  id?: string
  /** 角色类别；缺省为普通角色。Shadow 仅供内部临时 Agent 流程使用。 */
  kind?: 'role' | 'shadow'
  brain: string
  /** 角色头像字形；缺省时按角色 type 稳定映射内置头像。 */
  avatar?: string
  /**
   * 角色说明：仅 UI 详情卡展示（不注入 system prompt，与 systemPrompt 职责不重叠）。
   * 缺省 -> 详情卡无说明行。
   */
  description?: string
  /** 是否允许用户在输入框中通过 @ 选择此角色。缺省 false，避免配置/协调类角色被误派。 */
  mentionable?: boolean
  /** 单一感官组（每 agent 恰一个 sense group） */
  senseGroup: string
  /** 启用的 MCP server 名（缺省 []，与主 agent 平权） */
  mcpServers?: string[]
  systemPrompt?: string
  /**
   * 技能组：独立 skill 名子集（undefined = 全部独立 skill；[] = 无）。
   * role 激活时仅这些独立 skill 进入 system prompt `<skills>` 块。
   * 仅作用于 prompt 注入层（快照于 chat 创建时，"编制运行后不可改"）。
   */
  skills?: string[]
  /**
   * 插件组：plugin 名子集（undefined = 全部插件；[] = 无）。
   * role 激活时仅这些插件下的 skill 进入 `<skills>` 块。
   */
  plugins?: string[]
  /** 参数级行为限制；缺省采用 supervised，避免新旧角色无策略静默放行。 */
  permissions?: RolePermissionPolicy
  /** 锁定身份：禁止删除/改名/复制及修改 avatar/description/systemPrompt；cheryNyxus 仅允许切换 brain。 */
  lock?: boolean
}

/**
 * 预设：选中的角色 type 列表（引用 config.roles 单一源，不在预设内重定义编制）+ 指定组长。
 * 主 pet 启动选一套，编制运行后不可改；主 pet 编制取 leader 角色的 RoleConfig。
 * 旧 config.default 已并入「默认」预设（DEFAULT_PRESET_NAME）。
 */
export interface PresetConfig {
  /** Stable workspace identity. Display-name changes must preserve this value. */
  id?: string
  /** 与预设关联的内部 Shadow 流程。 */
  shadows?: {
    /** 选择消息应发送到哪个根会话；缺省表示关闭自动路由。 */
    conversationRouting?: string
  }
  /** References one member in roles; reserved for detail branches and excluded from spawn_role. */
  detailRole?: string
  /** 组长角色 type 名（必填，必须 ∈ config.roles 且 ∈ 下属 roles 列表）；主 pet 编制取此角色 */
  leader: string
  /** 选中的角色 type 名（引用 config.roles 已定义的键，不在预设内重定义） */
  roles?: string[]
  /** 按类型引用媒体服务名（引用 config.media 已定义的服务，类型须匹配） */
  mediaImage?: string
  mediaVideo?: string
  mediaAudio?: string
  /**
   * 项目工作目录绝对路径（提示词层注入：buildFirstSystemPrompt 注入 <workspace> 段声明本会话专属该项目）。
   * 仅 system prompt 提示，不约束 sense 实际行为（无 cwd 收束/路径沙箱）。缺省 → 不注入该段。
   * 校验策略：
   *   - 启动期（loadConfig）：非绝对路径 → 硬错误阻塞；绝对路径但目录不存在/不可访问 → 软警告 + 置 undefined（降级为空，下游 if(workspace) 自动跳过）
   *   - 保存期（saveRawConfig）：任一问题均返回错误给 UI，阻止写盘
   */
  workspace?: string
  /**
   * 定时触发器：到点 spawn 本预设 leader 执行 task（后端 cron scheduler，见 src/service/schedule/scheduler.ts）。
   * 典型用途：「维护」预设定时触发 curator 做 Dream（记忆整理）。
   * 缺省 → 不注册 cron 任务。
   */
  schedule?: PresetSchedule
  /**
   * smart 监管规则覆盖文件名（.chery/rule/ 下，不含 base.yaml）。
   * 与基准 base.yaml 深合并（dangerPatterns 追加去重；详见 docs/core/sense.md「smart 规则表」）。
   * chat.create 选预设时快照入 metadata.rule（子 agent 继承父）；缺省 → 仅用基准。
   */
  rule?: string
}

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
export interface PresetSchedule {
  /** 5 字段 cron（分 时 日 月 周），本地时区；如 "0 3 * * *" = 每天 03:00 */
  cron: string
  /** 交付 leader 执行的任务 prompt */
  task: string
  /** 是否启用，缺省 true。false → scheduler 跳过此预设 */
  enabled?: boolean
}

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
interface MemoryLimits {
  /** 活跃记忆最大条数（超限触发淘汰） */
  max_count?: number
  /** 单条记忆正文字数上限 */
  max_chars?: number
}

interface MemoryConfig {
  /** 全局层（跨 chat 共享；管用户习惯/事实/准则） */
  global?: MemoryLimits
  /** workspace 层（per chat / per 项目；管项目行为规范） */
  workspace?: MemoryLimits
}

/**
 * 文件压缩配置
 */
interface FileCompressionConfig {
  truncate_threshold?: number // 截断阈值（字节），默认150KB
  truncate_preview_lines?: number // 截断保留行数，默认100行
  log_file_extensions?: string[] // 日志文件扩展名列表
  drain_preview_count?: number // Drain模板实例数，默认3
}

/**
 * 日志配置
 */
interface LoggerConfig {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent' // 日志等级
  output?: ('console' | 'file')[] // 输出位置数组
  timestamp?: boolean // 是否显示时间戳
  location?: boolean // 是否显示调用位置
  format?: 'plain' | 'json' // 输出格式
}

/**
 * 阈值：支持 tokens（绝对）或 percent（0..1 占 context 窗口比）两种单位。
 * 前端填写**必须以 `%` 或 `k` 结尾**（如 `50%` / `64k`，不接受裸数字）；后端只处理结构体（确定性，规则 5）。
 */
export interface Threshold {
  unit: 'tokens' | 'percent'
  value: number
}

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
export interface CommandConfig {
  warn?: Threshold
  auto?: Threshold
  min_context_limit?: number
  safety_margin?: number
}

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
export interface HistoryRecallConfig {
  /** 单次返回的硬字符上限；超限截断并在尾部提示缩小 query / 指定 generation。 */
  max_output_chars?: number
}

/**
 * 全局配置
 */
interface GlobalConfig {
  thinking: boolean // 是否开启思考模式（如果能思考）
  supervision: SupervisionLevel // 全局默认的监管等级
  stream: boolean // 是否开启流式输出
  sense_execute_timeout?: number // 感官执行超时时间（毫秒）
  /**
   * 审批等待超时（毫秒）。`>= 0`，0 = 不限时（无用户超时，永远等用户决）。
   * `> 0` → 到点视为用户拒绝（工具不执行，loop 继续）；`0` → 不设置业务截止时间。
   * 不影响断连 grace / chat.abort 的 AgentParkError/AgentAbortError 路径。
   * 运行时由 core `createApproval(id, timeoutMs, hardTimeoutMs)` 消费；前端据 `interrupt.waitTime` 显倒计时。
   * 校验：`validateRawConfig` 强制 `>= 0` + `Number.isFinite`；`config.save` zod schema `.min(0).optional()`。
   */
  approval_timeout?: number
  /**
   * 审批等待期间的内存资源上限（毫秒），默认 1800000（30min）。
   * 到点只暂停并释放 runtime；持久 interaction 不终结，仍可从待办恢复处理。
   * 仅当 `approval_timeout<=0` 生效。运行时由 core createApproval 第 3 参消费。
   * 校验：`validateRawConfig` 强制 `>= 0` + `Number.isFinite`；`config.save` zod schema `.min(0).optional()`；缺省代码兜底 1800000。
   */
  approval_hard_timeout?: number
  maxLoopCount?: number // loop 最大执行次数（默认 30）
  /**
   * WS 断连宽限期（毫秒）。owner WebSocket 关闭后，等待该时间窗内同 requestId 的重连。
   * 到期仍无新 owner：标记当前 run 在「下一轮 loop 决策前」抛 AgentParkError 安全暂停；
   * 若有 pending approval 则立即 park。0 表示不等待，请求当前输出结束后立即暂停。
   * 校验：必须为有限且 >= 0 的数字。
   */
  disconnect_grace_ms?: number
  bash_log_retention_hours?: number // bash 日志文件保留时间（小时）
  file_compression?: FileCompressionConfig // 文件压缩配置
  logger?: LoggerConfig // 日志配置
  textEditor?: string // 文本编辑器路径（如 vscode、notepad、记事本等），用于打开配置文件
  command?: CommandConfig // 内置命令（compact 等）触发与可见性配置
  /**
   * 看门狗配置（子 agent 运行时监控，见 docs/agent-pet.md §5.4 feed-dog 看门狗）。
   * - timeout_ms：子无产出（observer for-await 无 chunk 喂狗）超过此值判定卡死，默认 300000（5min）。
   * - wake_on_timeout：超时是否唤主。true=通知主（注入超时说明）；false=仅暂停子（abort+clear），主不受影响，默认 false。
   *   统一暂停语义下子 chat 保持末条派生 canResume，用户可 resume 续跑。
   */
  watchdog?: { timeout_ms?: number; wake_on_timeout?: boolean }
  /** 节点树全量渲染阈值（节点数≤此值跳过视口裁剪避免平移卡顿；0=始终裁剪） */
  tree_full_render_threshold?: number
  /** history_recall 感官（长会话历史回忆）输出上限配置 */
  history_recall?: HistoryRecallConfig
}

/**
 * 服务配置（端口 + 传输格式，从环境变量迁移至此）
 */
interface ServerConfig {
  port: number // WebSocket 服务端口
  /** HTTP 静态服务 + /api/auth 登录端口；优先级 WEB_PORT 环境变量 > 本字段 > 默认 8183。 */
  webPort: number
  transport: 'binary' | 'json' // 传输格式：binary（二进制帧）/ json（JSON 字符串）
  /** Keep localhost by default; set 0.0.0.0 or an intranet address behind TLS/reverse proxy. */
  host?: string
  /**
   * 是否由后端 HTTP 服务托管前端 SPA（web/dist/）。开启则用单一 origin 解决跨域：
   * 浏览器访问 http://<host>:8183/ 同时拿到 UI 与 API，避免 vite proxy 与同源 cookie 边界。
   * - 缺省 true（仅当 `static_dir_override` 或默认 `web/dist` 存在时实际托管，否则日志警告并退化为仅 API）
   * - false → HTTP 服务仅 serve /api/*；UI 走 vite dev / Electron 各自路径
   * - 部署在反向代理后无需开启（nginx/caddy 已托管 SPA），配置即可关闭
   */
  serve_frontend?: boolean
  /**
   * 自定义前端构建产物路径（绝对路径），覆盖默认 `<repo>/web/dist`。
   * 典型用途：Electron 打包后落到 `resources/app`，或独立部署时把 dist/ 拷到任意目录。
   * 不设则与 `startService` 默认路径一致；设错则启动期日志警告并跳过托管。
   */
  static_dir_override?: string
  /** OIDC/OAuth2 authorization-code login for browser control-plane access. */
  auth?: OAuth2Config
  /**
   * 文件夹浏览协议（config.workspace.browse.*）配置。server 侧专属：
   * 被 config.get 剥离（设置面板不可编辑）、config.save 原样保留；改配置需编辑 config.yaml 后重启。
   */
  workspace_browse?: WorkspaceBrowseConfig
}

/** 文件夹浏览协议（config.workspace.browse.*）配置。 */
interface WorkspaceBrowseConfig {
  /** 允许浏览的根目录白名单（绝对路径，支持 ~ 展开）；缺省当前用户 home；win32 缺省枚举存在盘符。 */
  roots?: string[]
  /** 是否允许返回文件条目（硬上限：false 时调用方传 includeFiles:true 也被忽略为 false）。 */
  default_include_files?: boolean
  /** 是否显示隐藏条目（'.' 开头；.chery 恒隐藏不受此控）。 */
  show_hidden?: boolean
  /** 从根算起的最大浏览深度（缺省不限）。 */
  max_depth?: number
  /** 浏览会话存活毫秒数（缺省 600000 = 10 分钟）。 */
  session_ttl_ms?: number
  /** 每会话每分钟请求上限。 */
  rpm?: number
  /** 并发浏览会话上限。 */
  max_sessions?: number
}

/**
 * MCP server 单项配置
 * transport=stdio 时用 command/args/env 启动子进程；transport=streamable-http 时用 url 连接远程 server。
 * supervision 为 server 级默认监管等级（覆盖 global.supervision），可被 sense_groups 的 :level 进一步覆盖。
 */
interface McpServerConfig {
  transport: 'stdio' | 'streamable-http'
  command?: string // stdio：可执行文件
  args?: string[] // stdio：命令行参数
  env?: Record<string, string> // stdio：子进程环境变量（$ENV 占位符由 replaceEnvVars 注入）
  url?: string // streamable-http：server URL
  supervision?: SupervisionLevel // server 级默认监管等级（loadConfig 把字符串转枚举）
}

/**
 * 扩展全局配置（包含自动补全的路径）
 */
interface ExtendedGlobalConfig extends GlobalConfig {
  skills_dir: string // 自动补全：chery_dir + "/.chery/skills"
  plugins_dir: string // 自动补全：chery_dir + "/.chery/plugins"（插件整仓，loader 增量扫描并入可用 skills）
  senses_dir: string // 自动补全：chery_dir + "/.chery/senses"
  prompts_dir: string // 自动补全：chery_dir + "/.chery/prompt"（唯一 prompt 目录：含全局 base system.md + per-agent override 子文件夹）
  db_dir: string // 自动补全：chery_dir + "/db"
  memory_dir: string // 自动补全：chery_dir + "/.chery/memory"（非 workspace 模式记忆存储根目录）
  rule_dir: string // 自动补全：chery_dir + "/.chery/rule"（smart 监管敏感判定规则 yaml）
}

interface Config {
  global: ExtendedGlobalConfig
  llm: LLMConfig
  media?: MediaConfig
  sense_groups?: Record<string, string[]> // sense分组配置
  mcp_servers?: Record<string, McpServerConfig> // MCP server 配置（name → 连接参数 + server 级监管默认）
  server: ServerConfig // 服务配置（端口 + 传输格式，loadConfig 兜底默认值）
  /** 角色模块（spawn_role sense 按 type 查；单一源，预设按 type 引用） */
  roles?: Record<string, RoleConfig>
  /** 预设：命名编制包（leader 角色 + 选中角色 type 列表），主 pet 启动选一套。旧 config.default 已并入「默认」预设 */
  presets?: Record<string, PresetConfig>
  /** 项目记忆配置（条数/字数限制）；缺省 → max_count=15, max_chars=500 */
  memory?: MemoryConfig
}

/**
 * 原始（磁盘/YAML）全局配置：supervision 为字符串（未转枚举）、无路径补全。
 * 供 config.get/config.save RPC 传输与编辑。
 */
interface GlobalConfigRaw extends Omit<GlobalConfig, 'supervision'> {
  supervision: 'auto' | 'smart' | 'manual'
}

/** 原始 MCP server 配置：supervision 为字符串（未转枚举） */
interface McpServerConfigRaw extends Omit<McpServerConfig, 'supervision'> {
  supervision?: 'auto' | 'smart' | 'manual'
}

/**
 * 原始配置（config.get 返回 / config.save 入参）：无 server 段、无路径补全、
 * supervision 为字符串、key 仍为 $ENV 占位符。读写均不碰运行时内存单例（重启生效）。
 * export 供 config_manage 感官复用 saveRawConfig 入参类型。
 */
export interface ConfigRaw {
  global: GlobalConfigRaw
  llm: LLMConfig
  media?: MediaConfig
  sense_groups?: Record<string, string[]>
  mcp_servers?: Record<string, McpServerConfigRaw>
  roles?: Record<string, RoleConfig>
  presets?: Record<string, PresetConfig>
  memory?: MemoryConfig
}

// 同一变量可能被多个字段引用（如 4 个 brain 都用 $API_KEY），
// 用 Set 去重，避免控制台刷出 "API_KEY, API_KEY, API_KEY, API_KEY"。
const missingEnvVars = new Set<string>()

export function replaceEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    const envVarMatch = value.match(/^\$([A-Z_][A-Z0-9_]*)$/)
    if (envVarMatch && envVarMatch[1]) {
      const envVarName = envVarMatch[1]
      let envValue = process.env[envVarName]
      if (!envValue) {
        // 运行期新增的 .env 变量未进 process.env：重读 .env 补充一次（不覆盖 OS env 既有值）
        reloadEnvFile(false)
        envValue = process.env[envVarName]
      }
      if (!envValue) {
        missingEnvVars.add(envVarName)
        return value // 原样返回
      }
      return envValue
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map(replaceEnvVars)
  }

  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = replaceEnvVars(val)
    }
    return result
  }

  return value
}

function loadConfig(): Config {
  // .chery 目录路径（从环境变量读取，默认 process.cwd()）
  const cheryDir = process.env.CHERY_DIR || process.cwd()

  // 从 .chery/config.yaml 读取配置（运行时配置，不走打包）
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')

  if (!fs.existsSync(configPath)) {
    console.error(`✗ 配置文件不存在: ${configPath}`)
    console.error(`  请确认 CHERY_DIR 环境变量指向正确的项目根目录（当前: ${cheryDir}）`)
    process.exit(1)
  }

  const configFile = fs.readFileSync(configPath, 'utf8')
  const rawConfig = yaml.load(configFile) as Config

  const config = replaceEnvVars(rawConfig) as Config

  ensurePresetIds(config.presets)
  ensureRoleIds(config.roles)

  // 业务校验（raw 形态：supervision 仍为字符串）。启动期 fail loud（规则12）。
  // brain 引用 / supervision 合法值 / sense :level / brain 必填项均在此（原内联块抽出共用）。
  // workspace 不在此校验：启动期不关心（workspace 是环境配置非服务必需）。
  const rawErrors = validateRawConfig(config as unknown as ConfigRaw)
  if (rawErrors.length > 0) {
    throw new Error(`配置校验失败:\n${rawErrors.join('\n')}`)
  }

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
    const roleCheryDir = process.env.CHERY_DIR || process.cwd()
    for (const cfg of Object.values(config.roles)) {
      if (cfg.systemPrompt && !path.isAbsolute(cfg.systemPrompt)) {
        cfg.systemPrompt = path.join(roleCheryDir, '.chery', cfg.systemPrompt)
      }
    }
  }

  // brain.thinking 归一化为 ThinkingLevel（legacy boolean → level；非法 → "off"）。
  // 运行时 ctx.runtime.brain.thinking 必为 level，provider 据 level 映射请求参数。
  if (config.llm?.brain) {
    for (const cfg of Object.values(config.llm.brain)) {
      cfg.thinking = normalizeBrainThinking(cfg.thinking, cfg.provider)
    }
  }

  // 自动补全 .chery 目录路径
  config.global.skills_dir = path.join(cheryDir, '.chery', 'skills')
  config.global.plugins_dir = path.join(cheryDir, '.chery', 'plugins')
  config.global.senses_dir = path.join(cheryDir, '.chery', 'senses')
  config.global.prompts_dir = path.join(cheryDir, '.chery', 'prompt')
  config.global.db_dir = process.env.DB_DIR ?? path.join(cheryDir, '.chery', 'db')
  config.global.memory_dir = path.join(cheryDir, '.chery', 'memory')
  config.global.rule_dir = path.join(cheryDir, '.chery', 'rule')

  // 断连宽限期默认值：15000ms（与 .chery.template 同步；缺省 15s）
  config.global.disconnect_grace_ms =
    config.global.disconnect_grace_ms !== undefined ? config.global.disconnect_grace_ms : 15000

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
  const serverRaw = config.server as Partial<ServerConfig> | undefined
  config.server = {
    port: serverRaw?.port ?? 8182,
    webPort: Number(process.env.WEB_PORT ?? serverRaw?.webPort ?? 8183),
    transport: serverRaw?.transport === 'json' ? 'json' : 'binary',
    host: serverRaw?.host ?? '127.0.0.1',
    // 默认托管前端 SPA：仅在 dev/prod 产物存在时实际生效；缺失时日志警告并退化为仅 API
    serve_frontend: serverRaw?.serve_frontend !== false,
    static_dir_override: serverRaw?.static_dir_override,
    auth: serverRaw?.auth,
    workspace_browse: serverRaw?.workspace_browse,
  }

  // 添加环境变量缺失警告
  if (!process.env.CHERY_DIR) {
    console.warn(`⚠️ 环境变量 CHERY_DIR 未配置，使用默认路径: ${cheryDir}`)
  }

  if (missingEnvVars.size > 0) {
    console.warn(`⚠️ 环境变量未配置: ${Array.from(missingEnvVars).join(', ')}`)
  }

  return config
}

const config = loadConfig()

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
 * 修复点：原 loadConfig 用 SupervisionLevel[name] 转换，非法字符串静默变 undefined；
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
    // thinking：接受 legacy boolean（true/false）或 ThinkingLevel（off/on/low/medium/high/xhigh）；非法 fail loud
    // cfg.thinking 类型已为 ThinkingLevel，运行时值可能是 legacy boolean/字符串，用 unknown 比较避开类型冲突
    const t = cfg?.thinking as unknown
    if (
      t !== undefined &&
      t !== true &&
      t !== false &&
      t !== 'off' &&
      t !== 'on' &&
      t !== 'low' &&
      t !== 'medium' &&
      t !== 'high' &&
      t !== 'xhigh'
    ) {
      errors.push(
        `llm.brain.${name}.thinking 非法（合法：true/false 或 off/on/low/medium/high/xhigh）`,
      )
    }
    if (
      cfg?.capabilities?.generate &&
      cfg.capabilities.toolCall === false &&
      Object.values(cfg.capabilities.generate).some(Boolean)
    ) {
      errors.push(`llm.brain.${name}.capabilities.generate 需要 Tool Call 能力`)
    }
  }

  // media.* 命名服务：type 合法 + enabled 时 url 必填
  const VALID_MEDIA_KIND = ['image', 'video', 'audio'] as const
  const mediaNames = Object.keys(raw.media ?? {})
  if (raw.media) {
    for (const [name, cfg] of Object.entries(raw.media)) {
      if (!cfg?.type || !VALID_MEDIA_KIND.includes(cfg.type)) {
        errors.push(`media.${name}.type 非法（合法：image/video/audio）`)
      }
      if (cfg?.enabled && !cfg.url) {
        errors.push(`media.${name} 已启用但 url 为空`)
      }
    }
  }

  // roles.*.brain 必须存在于 llm.brain；roles.*.systemPrompt 文件存在性（相对 .chery 目录解析；绝对路径原样）。
  if (raw.roles) {
    const cheryDir = process.env.CHERY_DIR || process.cwd()
    for (const [name, cfg] of Object.entries(raw.roles)) {
      if (cfg.id !== undefined && !/^role-[a-zA-Z0-9_-]{8,}$/.test(cfg.id)) {
        errors.push(`roles.${name}.id 非法（必须以 role- 开头且至少包含 8 位标识）`)
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
    for (const [pname, pcfg] of Object.entries(raw.presets)) {
      if (pcfg.id !== undefined && !/^preset-[a-zA-Z0-9_-]{8,}$/.test(pcfg.id)) {
        errors.push(`presets.${pname}.id 非法（必须以 preset- 开头且至少包含 8 位标识）`)
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
      // mediaImage/mediaVideo/mediaAudio 引用必须存在于 config.media 且 type 匹配
      const mediaByKind: Record<string, string | undefined> = {
        image: pcfg.mediaImage,
        video: pcfg.mediaVideo,
        audio: pcfg.mediaAudio,
      }
      for (const [kind, ref] of Object.entries(mediaByKind)) {
        if (!ref) continue
        if (!mediaNames.includes(ref)) {
          errors.push(
            `presets.${pname}.media${kind} "${ref}" 不在 media 服务列表（可用：${mediaNames.join(', ') || '（未配置任何媒体服务）'}）`,
          )
        } else if (raw.media?.[ref]?.type !== kind) {
          errors.push(
            `presets.${pname}.media${kind} "${ref}" 类型为 ${raw.media?.[ref]?.type ?? '未知'}，非 ${kind}`,
          )
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
  const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as ConfigRaw & { server?: unknown }
  // 端口/传输不通过面板编辑，剥离 server
  const { server: _server, ...rest } = raw
  void _server
  ensurePresetIds(rest.presets)
  ensureRoleIds(rest.roles)
  // routingBrain 已废弃；读取设置时主动剥离，下一次保存自然从磁盘删除。
  for (const preset of Object.values(rest.presets ?? {})) {
    delete (preset as PresetConfig & { routingBrain?: string }).routingBrain
  }
  // brain.thinking 归一化为 ThinkingLevel（前端 config.get 拿到的就是 level，无需再处理 legacy boolean）
  if (rest.llm?.brain) {
    for (const cfg of Object.values(rest.llm.brain)) {
      cfg.thinking = normalizeBrainThinking(cfg.thinking, cfg.provider)
    }
  }
  return rest
}

/**
 * 配置敏感字段脱敏（供 config_manage get 返回 / 前端 config.get 前过滤）。
 * 规则（对照 docs/agent/config-manage.md「敏感字段脱敏」）：
 *  - `$ENV` 占位符（/^\$[A-Z_][A-Z0-9_]*$/）原样保留——运行时由 replaceEnvVars 注入，占位符本身非敏感。
 *  - `llm.brain.*.key` / `media.*.key`：非 $ENV 明文 → `[REDACTED]`。
 *  - `mcp_servers.*.env`：每个值非 $ENV → `[REDACTED]`。
 *  - `mcp_servers.*.url`：内联凭证（scheme://user:pass@host）→ 凭证段 `[REDACTED]`（url 其余保留）。
 * 深拷贝返回，不改入参。
 */
const ENV_PLACEHOLDER_RE = /^\$[A-Z_][A-Z0-9_]*$/

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
  if (copy.media) {
    for (const svc of Object.values(copy.media)) {
      if (svc.key !== undefined) svc.key = redactSecretValue(svc.key)
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
 * 配置敏感字段还原（供 config_manage save / 前端 config.save 落盘前）。
 * 把 partial 中值为 `[REDACTED]` 的敏感字段替换为盘上（disk）原值——模型 get → 改无关字段 → save
 * 传回 [REDACTED] 不会覆盖真实 key；若模型显式给出新明文（非 [REDACTED]）则以新值为准（允许换 key）。
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
  if (copy.media && disk.media) {
    for (const [name, svc] of Object.entries(copy.media)) {
      const diskSvc = disk.media[name]
      if (svc.key === '[REDACTED]' && diskSvc?.key !== undefined) svc.key = diskSvc.key
    }
  }
  if (copy.mcp_servers && disk.mcp_servers) {
    for (const [name, srv] of Object.entries(copy.mcp_servers)) {
      const diskSrv = disk.mcp_servers[name]
      if (srv.env && diskSrv?.env) {
        for (const k of Object.keys(srv.env)) {
          if (srv.env[k] === '[REDACTED]' && diskSrv.env[k] !== undefined) srv.env[k] = diskSrv.env[k]
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
  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')
  const backupsDir = path.join(cheryDir, '.chery', 'backups')
  // 自愈：确保备份目录存在；缺省回滚目标由候选备份决定。
  fs.mkdirSync(backupsDir, { recursive: true })
  const candidates = fs
    .readdirSync(backupsDir)
    .filter((f) => /^config-\d{8}-\d{6}\.yaml$/.test(f))
    .sort()
    .reverse()
  const target = backupName && candidates.includes(backupName) ? backupName : candidates[0]
  if (!target) throw new Error('备份目录为空，尚无可用备份（首次 action="save" 后才会生成）')
  fs.copyFileSync(path.join(backupsDir, target), configPath)
  return { backup: target }
}

/**
 * 校验 + 写回 .chery/config.yaml（供 config.save 与 config_manage 感官）。
 * 不碰运行时内存单例（重启生效）。失败 fail loud 返回 errors，不写盘。
 * 返回分离 errors（硬错误）+ warnings（软错误：workspace 路径无效），供 UI 分层展示。
 * workspace 路径校验仅在保存期做（启动期不关心 workspace 数据正确性）。
 * 写回保留盘上 server 段不动，js-yaml dump 无注释（注释文档备份在 config.yaml.example）。
 * 写盘前自动备份旧配置到 .chery/backups/（保留最近 10 份，见 backupConfig），出错可 rollbackConfig 回滚。
 */
export function saveRawConfig(
  partial: ConfigRaw,
): { ok: true } | { ok: false; errors: string[]; warnings: string[] } {
  const errors = validateRawConfig(partial)
  // workspace 单独校验（启动期不参与；保存期非绝对路径 → 硬错误；其他无效目录 → 软警告）
  const warnings: string[] = []
  if (partial.presets) {
    for (const [pname, pcfg] of Object.entries(partial.presets)) {
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
  if (errors.length > 0 || warnings.length > 0) {
    return { ok: false, errors, warnings }
  }

  const cheryDir = process.env.CHERY_DIR || process.cwd()
  const configPath = path.join(cheryDir, '.chery', 'config.yaml')

  // 读盘取 server 段（保留不动），合并 partial（除 server 外全部字段）
  const disk = yaml.load(fs.readFileSync(configPath, 'utf8')) as ConfigRaw & {
    server?: ServerConfig
  }
  errors.push(...validateLockedRoleEdits(disk.roles, partial.roles))
  errors.push(...validateFixedPresetEdits(disk.presets, partial.presets))
  if (errors.length > 0) return { ok: false, errors, warnings }
  // 落盘前补全缺失 id（前端新建角色未带 id；改名场景 value 对象随行携带 id，此处不覆盖）。
  ensurePresetIds(partial.presets)
  ensureRoleIds(partial.roles)
  const merged = { ...partial, server: disk.server ?? { port: 8182, transport: 'binary' as const } }

  // 写盘前备份旧配置（.chery/backups/，保留最近 10 份）——回滚到修改前状态的唯一依据。
  // 校验失败路径已提前 return，不会走到这里，故不会产生无效备份。
  backupConfig(configPath)
  fs.writeFileSync(configPath, yaml.dump(merged, { lineWidth: -1 }))
  return { ok: true }
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
  const errors = validateRawConfig(copy)
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
  return dotenv.parse(fs.readFileSync(rootEnvPath, 'utf8'))
}

/**
 * 运行期按需重读 .env 文件，同步进 process.env（dotenv.config 只在模块加载时执行一次）。
 *  - override=false（默认）：只填充 process.env 缺失的键，不覆盖 OS env / 启动时已加载的值。
 *  - override=true：以 .env 为准覆盖既有值（用户明确「重载文件」意图，如点击密钥刷新）。
 * .env 不存在或不可读时静默忽略，保持现有 process.env。
 */
export function reloadEnvFile(override = false): void {
  try {
    const parsed = dotenv.parse(fs.readFileSync(rootEnvPath, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) {
      if (override || !(key in process.env)) process.env[key] = value
    }
  } catch {
    // .env 缺失/不可读：保持现状
  }
}

/**
 * 获取 .chery 目录路径（从环境变量 CHERY_DIR 或默认 process.cwd()）。
 * 供 utils.openFile 等 handler 使用。
 */
export function getCheryDir(): string {
  return process.env.CHERY_DIR || process.cwd()
}

export type {
  Config,
  BrainConfig,
  GlobalConfig,
  LoggerConfig,
  McpServerConfig,
  ServerConfig,
}
export default config
