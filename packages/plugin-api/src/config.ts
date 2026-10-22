import type {
  CapabilityState,
  FileCapabilityOperation,
  FileServiceAdapterId,
  LlmProtocol,
} from '@chery/protocol'
import type { SupervisionLevel } from './sense.js'
import type { ThinkingLevel } from './hooks.js'
export type { CapabilityState, FileCapabilityOperation, FileServiceAdapterId }
export interface OAuth2Config { enabled?: boolean; trustedOrigins?: string[]; username?: string; password?: string; allowLoopback?: boolean; machine?: { username: string; password: string } }
export type MockScriptError =
  | string
  | {
      message: string
      userMessage?: string
      category?: 'auth' | 'network' | 'provider' | 'timeout' | 'validation' | 'unknown'
      source?: 'brain' | 'sense' | 'media' | 'mcp' | 'chat' | 'system' | 'hook'
    }

export interface MockScriptChunk {
  thinking?: string
  content?: string
  senseCalls?: { id?: string; name: string; arguments: string }[]
  delayMs?: number
  error?: MockScriptError
}

export interface MockScriptResponse {
  /** 思考增量 */
  thinking?: string
  /** 正文增量 */
  content?: string
  /** 工具调用（监管等级由 sense_groups 的 :level 决定，非脚本） */
  senseCalls?: { id?: string; name: string; arguments: string }[]
  /** 抛错（测 retry 中间件） */
  error?: MockScriptError
  /** Ordered stream script. When present it replaces the legacy thinking/content/senseCalls split. */
  chunks?: MockScriptChunk[]
  /** Per-call outcomes for retries within this logical assistant turn. */
  attempts?: Array<Omit<MockScriptResponse, 'attempts'>>
  /** 每个 delta chunk 之间 sleep 毫秒（模拟流式节奏，刷新/重连测试用）；缺省取 brain.mock.chunkDelayMs */
  chunkDelayMs?: number
  /** 本轮首次响应前 sleep 毫秒（模拟首 token 延迟）；缺省取 brain.mock.preRespondMs */
  preRespondMs?: number
}

export interface MockConfig {
  /** 开关：是否启用 mock（缺省 true） */
  enabled?: boolean
  /** 脚本文件路径，相对 .chery 目录（如 mock/read_file.yaml） */
  file: string
  /** 全局兜底：每个 delta chunk 之间 sleep 毫秒（脚本项缺省时取此，默认 0 不延迟） */
  chunkDelayMs?: number
  /** 全局兜底：本轮首次响应前 sleep 毫秒（脚本项缺省时取此，默认 0） */
  preRespondMs?: number
}

export type CapabilityValue = CapabilityState | boolean

export interface MediaCapabilities {
  image?: CapabilityValue
  video?: CapabilityValue
  audio?: CapabilityValue
  pdf?: CapabilityValue
}

export interface OutputCapabilities {
  image?: CapabilityValue
  video?: CapabilityValue
  audio?: CapabilityValue
}

export interface BrainCapabilities {
  imageOutput?: import('@chery/protocol').ImageOutputCapabilities
  imageInput?: {
    formats?: Array<'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'>
    animation?: 'supported' | 'first-frame' | 'unsupported' | 'unknown'
    maxBytes?: number
    maxBase64Bytes?: number
  }
  toolCall?: boolean
  input?: MediaCapabilities
  output?: OutputCapabilities
}

export interface FileServiceConnection {
  capabilities?: { imageOutput?: import('@chery/protocol').ImageOutputCapabilities }
  /** 引用已有 llm.brain.<name> 连接；与独立 baseUrl/keyRef 互斥 */
  brainRef?: string
  /** 独立服务地址（支持 $ENV 占位符） */
  baseUrl?: string
  /** 独立模型或接入点 ID（如 image-01、gpt-image-1、doubao-seedream-5-0-pro-260628） */
  model?: string
  /** 独立密钥引用（支持 $ENV 占位符） */
  keyRef?: string
  /** 认证方式（默认 bearer；本地服务可設 none） */
  authType?: 'bearer' | 'x-api-key' | 'query-key' | 'none'
  /** 按操作覆盖完整请求端点 URL（配置后不再拼接默认路径） */
  endpointOverrides?: Partial<Record<FileCapabilityOperation, string>>
}

export interface FileServiceConfig {
  toolMapping?: {
    toolName: string
    inputAssetField: string
    questionField: string
    transferMode: 'base64' | 'data-url' | 'asset-id'
    constantParams?: Record<string, unknown>
    resultPath?: string
  }
  /** 用户可见显示名 */
  name: string
  /** 是否启用（默认 true） */
  enabled?: boolean
  /** 已注册适配器 ID */
  adapter: FileServiceAdapterId
  /** 连接与认证配置 */
  connection: FileServiceConnection
  /** 启用的操作列表（必须为 adapter 支持操作的子集） */
  operations: FileCapabilityOperation[]
  /** 默认画面参数；张数只使用全局默认与当次请求，不在这里保存。 */
  defaults?: Record<string, unknown>
  /** 单次外部操作超时毫秒数（默认 600000） */
  timeoutMs?: number
  /** 排队等待最长毫秒数（默认 600000） */
  queueTimeoutMs?: number
  /** 服务级最大并发数（默认 2） */
  maxConcurrent?: number
}

export type RoleFileCapabilityMode = 'auto' | 'native' | 'tool' | 'role' | 'disabled'

export interface RoleFileCapabilityBinding {
  mode: RoleFileCapabilityMode
  /** mode 为 tool 或 role 时必填稳定工具名或角色 ID；native/auto/disabled 禁止填写 */
  targetId?: string
  /** 失败策略，默认 none（不静默切换其他付费服务） */
  fallback?: 'none'
}

export type RoleFileCapabilitiesMap = Partial<
  Record<FileCapabilityOperation, RoleFileCapabilityBinding>
>

export interface PresetRoleOverride {
  fileCapabilities?: RoleFileCapabilitiesMap
}

export interface FilesContextConfig {
  /** 其他文件的用户轮数；图片独立使用 imageContext。0 表示仅当前轮。 */
  recentUserTurns?: number
  /** 单次请求携带的不同资产版本上限（正整数，默认 10） */
  maxAssets?: number
  /** 单次请求二进制附件字节预算上限（正整数，默认 16 MiB） */
  maxBinaryBytes?: number
  /** 单文件最大提取字符数（正整数，默认 20000） */
  maxExtractedCharsPerAsset?: number
  /** 单次请求累计最大提取字符数（正整数，默认 80000） */
  maxExtractedChars?: number
  /** 默认图片版本选择（默认 adapted） */
  defaultImageVariant?: 'original' | 'adapted'
}

export interface FilesImageAdaptationConfig {
  /** 单张模型输入图片硬上限，默认 5 MB = 5,000,000 字节；不是目标体积。 */
  maxBytes?: number
  /** 适配图最大边像素（正整数，默认 2048，不放大小图） */
  maxEdge?: number
  /** JPEG/WebP 转换或压缩的编码质量上限 1-100（默认 85）；合规原图复用，PNG 不使用有损 quality。 */
  quality?: number
}

export interface FilesConfig {
  imageGeneration?: { defaultCount?: number }
  /** 上传单文件字节上限（正整数，默认 100 MiB） */
  maxUploadBytes?: number
  context?: FilesContextConfig
  imageContext?: {
    mode?: 'current' | 'recent' | 'unlimited'
    recentUserTurns?: number
    replacement?: 'description' | 'keywords'
    missingDescription?: 'existing' | 'inspect'
    serviceId?: string
    maxDescriptionChars?: number
    maxTotalDescriptionChars?: number
  }
  imageAdaptation?: FilesImageAdaptationConfig
  /** 未提交且无引用的暂存上传保留小时数（正整数，默认 24） */
  unreferencedUploadRetentionHours?: number
  /** 解除最后引用后的持久资产延迟清理小时数（正整数，默认 24） */
  unreferencedAssetRetentionHours?: number
}

export interface BrainConfig {
  url?: string
  model: string
  key?: string
  /** 思考强度档位（ThinkingLevel）：off=关闭，low/medium/high/xhigh=强度递增。仅接受非空字符串显示词。 */
  thinking?: ThinkingLevel
  /** 服务入口预设（官方厂商、中转站或 custom）。旧配置中也兼作 adapter 名。 */
  provider: string
  /** HTTP 线协议；缺省时从旧 provider 推断，保证历史配置兼容。 */
  protocol?: LlmProtocol
  /** 每分钟最大请求数（RPM）限额，provider 层滑动窗口限流，未配置则不限流 */
  rpm?: number
  /** true=URL 已含完整端点（如 /v1/messages），provider 完全不拼接、原样访问；
   * 缺省 false=只拼端点（版本段 /v1 由用户填写）。规则见 docs/backend/agent/provider.md「URL 解析与端点拼接」。 */
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

export interface LLMConfig {
  brain: Record<string, BrainConfig>
}

export type RolePermissionTemplate = 'read-only' | 'workspace-developer' | 'supervised' | 'trusted'

export type RolePermissionEffect = 'inherit' | 'allow' | 'ask' | 'deny'

export type CommandRiskCategory =
  | 'config'
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
  /**
   * 角色归属域：`public` 为公共角色（全局共享单一源，可被任意预设引用；组长不能是公共角色）；
   * 缺省或 `private` 为预设内私有角色（归属单一预设）。
   */
  scope?: 'public' | 'private'
  /** 角色级文件能力绑定（操作 ID → 处理模式与首选目标） */
  fileCapabilities?: RoleFileCapabilitiesMap
}

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
  /** 预设成员级覆盖（如公共角色在不同预设使用不同文件能力目标） */
  roleOverrides?: Record<string, PresetRoleOverride>
  /**
   * 项目工作目录绝对路径（提示词层注入：buildFirstSystemPrompt 注入 <workspace> 段声明本会话专属该项目）。
   * 仅 system prompt 提示，不约束 sense 实际行为（无 cwd 收束/路径沙箱）。缺省 → 不注入该段。
   * 校验策略：
   *   - 启动期（loadConfig）：非绝对路径 → 硬错误阻塞；绝对路径但目录不存在/不可访问 → 软警告 + 置 undefined（降级为空，下游 if(workspace) 自动跳过）
   *   - 保存期（saveRawConfig）：任一问题均返回错误给 UI，阻止写盘
   */
  workspace?: string
  /**
   * 定时触发器：到点 spawn 本预设 leader 执行 task（后端 cron scheduler，见 apps/backend/src/service/schedule/scheduler.ts）。
   * 典型用途：「维护」预设定时触发 curator 做 Dream（记忆整理）。
   * 缺省 → 不注册 cron 任务。
   */
  schedule?: PresetSchedule
  /**
   * smart 监管规则覆盖文件名（.chery/rule/ 下，不含 base.yaml）。
   * 与基准 base.yaml 深合并（dangerPatterns 追加去重；详见 docs/backend/core/sense.md「smart 规则表」）。
   * chat.create 选预设时快照入 metadata.rule（子 agent 继承父）；缺省 → 仅用基准。
   */
  rule?: string
}

export interface PresetSchedule {
  /** 5 字段 cron（分 时 日 月 周），本地时区；如 "0 3 * * *" = 每天 03:00 */
  cron: string
  /** 交付 leader 执行的任务 prompt */
  task: string
  /** 是否启用，缺省 true。false → scheduler 跳过此预设 */
  enabled?: boolean
}

export interface MemoryLimits {
  /** 活跃记忆最大条数（超限触发淘汰） */
  max_count?: number
  /** 单条记忆正文字数上限 */
  max_chars?: number
}

export interface MemoryConfig {
  /** 全局层（跨 chat 共享；管用户习惯/事实/准则） */
  global?: MemoryLimits
  /** workspace 层（per chat / per 项目；管项目行为规范） */
  workspace?: MemoryLimits
}

export interface FileCompressionConfig {
  truncate_threshold?: number // 截断阈值（字节），默认150KB
  truncate_preview_lines?: number // 截断保留行数，默认100行
  log_file_extensions?: string[] // 日志文件扩展名列表
  drain_preview_count?: number // Drain模板实例数，默认3
}

export interface LoggerConfig {
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent' // 日志等级
  output?: ('console' | 'file')[] // 输出位置数组
  timestamp?: boolean // 是否显示时间戳
  location?: boolean // 是否显示调用位置
  format?: 'plain' | 'json' // 输出格式
}

export interface Threshold {
  unit: 'tokens' | 'percent'
  value: number
}

export interface CommandConfig {
  warn?: Threshold
  auto?: Threshold
  min_context_limit?: number
  safety_margin?: number
}

export interface HistoryRecallConfig {
  /** 单次返回的硬字符上限；超限截断并在尾部提示缩小 query / 指定 generation。 */
  max_output_chars?: number
}

export interface GlobalConfig {
  thinking: boolean // 是否开启思考模式（如果能思考）
  supervision: SupervisionLevel // 全局默认的监管等级
  stream: boolean // 是否开启流式输出
  /** 单次模型请求的总时长上限（毫秒）；0 = 不限制，缺省 10 分钟。 */
  llm_request_timeout_ms?: number
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
  file_compression?: FileCompressionConfig // 文件压缩配置
  logger?: LoggerConfig // 日志配置
  textEditor?: string // 文本编辑器路径（如 vscode、notepad、记事本等），用于打开配置文件
  command?: CommandConfig // 内置命令（compact 等）触发与可见性配置
  /**
   * 看门狗配置（子 agent 运行时监控，见 docs/shared/architecture/agent-orchestration.md §5.4 feed-dog 看门狗）。
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

export interface ServerConfig {
  /** Startup business profile; authentication is never disabled by this field. */
  businessPreset?: 'basic' | 'full'
  port: number // WebSocket 服务端口
  /** HTTP 静态服务 + /api/auth 登录端口；优先级 WEB_PORT 环境变量 > 本字段 > 默认 8183。 */
  webPort: number
  transport: 'binary' | 'json' // 传输格式：binary（二进制帧）/ json（JSON 字符串）
  /** Keep localhost by default; set 0.0.0.0 or an intranet address behind TLS/reverse proxy. */
  host?: string
  /**
   * 是否由后端 HTTP 服务托管前端 SPA（apps/web/dist/）。开启则用单一 origin 解决跨域：
   * 浏览器访问 http://<host>:8183/ 同时拿到 UI 与 API，避免 vite proxy 与同源 cookie 边界。
   * - 缺省 true（仅当 `static_dir_override` 或默认 `apps/web/dist` 存在时实际托管，否则日志警告并退化为仅 API）
   * - false → HTTP 服务仅 serve /api/*；UI 走 vite dev / Electron 各自路径
   * - 部署在反向代理后无需开启（nginx/caddy 已托管 SPA），配置即可关闭
   */
  serve_frontend?: boolean
  /**
   * 自定义前端构建产物路径（绝对路径），覆盖默认 `<repo>/dist/web`。
   * 典型用途：Electron 打包后落到 `resources/app`，或独立部署时把 dist/ 拷到任意目录。
   * 不设则与 `startService` 默认路径一致；设错则启动期日志警告并跳过托管。
   */
  static_dir_override?: string
  /** 本地后端用户名密码鉴权；OIDC 客户端只配置在公共中转。 */
  auth?: OAuth2Config
  /** Optional loopback-only listeners used by the rathole client. Ports may be 0 for allocation. */
  remote?: {
    enabled?: boolean
    httpPort?: number
    websocketPort?: number
  }
  /**
   * 文件夹浏览协议（config.workspace.browse.*）配置。server 侧专属：
   * 被 config.get 剥离（设置面板不可编辑）、config.save 原样保留；改配置需编辑 config.yaml 后重启。
   */
  workspace_browse?: WorkspaceBrowseConfig
}

export interface ManagerConfig {
  /**
   * 管理器监听地址；缺省 127.0.0.1。0.0.0.0 或内网 IP 开放内网访问，
   * 访问需携带启动日志 URL 上的管理密钥。优先级 CHERY_MANAGER_HOST > 本字段。
   */
  host?: string
}

export interface WorkspaceBrowseConfig {
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

export interface McpServerConfig {
  transport: 'stdio' | 'streamable-http'
  command?: string // stdio：可执行文件
  args?: string[] // stdio：命令行参数
  env?: Record<string, string> // stdio：子进程环境变量（$ENV 占位符由 replaceEnvVars 注入）
  url?: string // streamable-http：server URL
  supervision?: SupervisionLevel // server 级默认监管等级（loadConfig 把字符串转枚举）
}

export interface ExtendedGlobalConfig extends GlobalConfig {
  skills_dir: string // 自动补全：chery_dir + "/.chery/skills"
  plugins_dir: string // 自动补全：chery_dir + "/.chery/plugins"（插件整仓，loader 增量扫描并入可用 skills）
  senses_dir: string // 自动补全：chery_dir + "/.chery/senses"
  prompts_dir: string // 自动补全：chery_dir + "/.chery/prompt"（唯一 prompt 目录：含全局 base system.md + per-agent override 子文件夹）
  db_dir: string // 自动补全：chery_dir + "/db"
  memory_dir: string // 自动补全：chery_dir + "/.chery/memory"（非 workspace 模式记忆存储根目录）
  rule_dir: string // 自动补全：chery_dir + "/.chery/rule"（smart 监管敏感判定规则 yaml）
}

export interface Config {
  global: ExtendedGlobalConfig
  llm: LLMConfig
  sense_groups?: Record<string, string[]> // sense分组配置
  mcp_servers?: Record<string, McpServerConfig> // MCP server 配置（name → 连接参数 + server 级监管默认）
  server: ServerConfig // 服务配置（端口 + 传输格式，loadConfig 兜底默认值）
  /** 角色模块（spawn_role sense 按 type 查；单一源，预设按 type 引用） */
  roles?: Record<string, RoleConfig>
  /** 预设：命名编制包（leader 角色 + 选中角色 type 列表），主 pet 启动选一套。旧 config.default 已并入「默认」预设 */
  presets?: Record<string, PresetConfig>
  /** 项目记忆配置（条数/字数限制）；缺省 → max_count=15, max_chars=500 */
  memory?: MemoryConfig
  /** 文件服务配置（serviceId → 连接与启用操作） */
  file_services?: Record<string, FileServiceConfig>
  /** 全局文件与上下文策略配置 */
  files?: FilesConfig
}

export interface GlobalConfigRaw extends Omit<GlobalConfig, 'supervision'> {
  supervision: 'auto' | 'smart' | 'manual'
}

export interface McpServerConfigRaw extends Omit<McpServerConfig, 'supervision'> {
  supervision?: 'auto' | 'smart' | 'manual'
}

export interface ConfigRaw {
  global: GlobalConfigRaw
  llm: LLMConfig
  sense_groups?: Record<string, string[]>
  mcp_servers?: Record<string, McpServerConfigRaw>
  roles?: Record<string, RoleConfig>
  presets?: Record<string, PresetConfig>
  memory?: MemoryConfig
  file_services?: Record<string, FileServiceConfig>
  files?: FilesConfig
  /** 本地管理器监听配置（server 侧专属，设置面板不可编辑；见 .chery.template/docs/config.md）。 */
  manager?: ManagerConfig
}
