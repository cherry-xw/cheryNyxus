import OpenAI from 'openai'
import { Ollama } from 'ollama'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { promisify } from 'node:util'
import { exec as execCallback } from 'node:child_process'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type UtilsModelsRequestData,
  type UtilsModelsResponseData,
  type UtilsTestConnectionRequestData,
  type UtilsTestConnectionResponseData,
  type EnvListRequestData,
  type EnvListResponseData,
  type UtilsOpenFileRequestData,
  type UtilsOpenFileResponseData,
  type UtilsOpenConfigDirRequestData,
  type UtilsOpenConfigDirResponseData,
  type UtilsEditorsRequestData,
  type UtilsEditorsResponseData,
  type UtilsModelRecommendationRequestData,
  type UtilsModelRecommendationResponseData,
} from '../message/types.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { replaceEnvVars, listEnvVarNames, reloadEnvFile, getCheryDir } from '@/utils/config.js'
import { resetEnvVarCache } from '@/utils/envGuard.js'
import config from '@/utils/config.js'
import {
  resolveCatalogReasoningHistory,
  resolveCatalogThinkingParams,
  resolveModelCatalog,
} from '@/utils/modelCatalog.js'
import {
  ClassifiedError,
  COMPLIANT_TRACE_PATTERN,
  classifyError,
  friendlyMessage,
} from '@/utils/error.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter, type LLMResponse } from '@/core/message/adapter.js'
import { openWithSystem } from './openWithSystem.js'
import {
  readErrorSnippet,
  resolveProviderUrl,
  buildEndpointUrl,
} from '@/agent/provider/fetchBase.js'
import { ANTHROPIC_VERSION } from '@/agent/provider/anthropic.js'
import { LlmProtocol } from '@chery/protocol'
import { resolveBrainAdapterKey, resolveBrainProtocol } from '@/core/llm/routing.js'

const exec = promisify(execCallback)

/**
 * utils.models：基于用户提供的 provider/url/key 拉取可用模型列表。
 * 请求失败时返回 { models: [], error }，不抛 RpcError（前端可展示错误提示）。
 */
export async function handleUtilsModels(
  _ctx: HandlerContext,
  data: UtilsModelsRequestData,
): Promise<UtilsModelsResponseData> {
  const provider = data.provider
  const protocol = resolveBrainProtocol(data)
  const url = replaceEnvVars(data.url) as string
  const key = data.key ? (replaceEnvVars(data.key) as string) : undefined

  try {
    switch (protocol) {
      case LlmProtocol.OPENAI_CHAT_COMPLETIONS:
      case LlmProtocol.OPENAI_RESPONSES:
        return await fetchOpenAIModels(
          url,
          key,
          resolveBrainAdapterKey(data),
          data.fullUrl === true,
        )
      case LlmProtocol.OLLAMA_CHAT:
        return await fetchOllamaModels(url)
      case LlmProtocol.ANTHROPIC_MESSAGES:
        // DeepSeek 的 Anthropic chat base 是 /anthropic，但模型目录仍走官方 OpenAI
        // 兼容根地址的 /models；不要错误请求 /anthropic/models。
        if (provider === 'deepseek' && data.fullUrl !== true) {
          return await fetchOpenAIModels(
            url.replace(/\/anthropic\/?$/i, ''),
            key,
            'deepseek',
            false,
          )
        }
        return await fetchAnthropicModels(url, key, data.fullUrl === true)
      default:
        return {
          models: [],
          error: `不支持 provider=${provider} protocol=${data.protocol ?? 'legacy'}`,
        }
    }
  } catch (err) {
    // 复用 chat 路径的分类 + 中文友好文案（不要把 OpenAI SDK 抛的英文 'Connection error.'
    // 透传给前端）。日志面保留原始 message 供 tracingId 检索。
    const message = err instanceof Error ? err.message : String(err)
    const category = classifyError(err)
    const userMessage = friendlyMessage(category, 'brain')
    logger.event('utils.models.error', { provider, url, error: message, category }, LogLevel.warn)
    return { models: [], error: userMessage }
  }
}

/**
 * utils.testConnection：使用未保存的连接字段执行真实最小 Provider 请求。
 * 不创建 chat、不经过 middleware/retry/sense、不持久化任何数据。
 */
export async function handleUtilsTestConnection(
  _ctx: HandlerContext,
  data: UtilsTestConnectionRequestData,
): Promise<UtilsTestConnectionResponseData> {
  const { provider, model } = data
  const protocol = resolveBrainProtocol(data)
  if (provider === 'mock' || protocol === LlmProtocol.MOCK) {
    return { ok: false, error: 'mock 是离线模拟，无需测试连接' }
  }

  const adapterKey = resolveBrainAdapterKey(data)
  const llmAdapter = getLLMAdapter(adapterKey)
  const messageAdapter = getMessageAdapter(adapterKey)
  if (!llmAdapter || !messageAdapter) {
    return { ok: false, error: `不支持的 provider: ${provider}` }
  }

  const url = replaceEnvVars(data.url) as string
  const key = data.key ? (replaceEnvVars(data.key) as string) : undefined
  const now = Date.now()
  const probeMessage: LLMResponse = {
    id: 'connection-test',
    role: 'user',
    content: '只回复 OK',
    createdAt: now,
    updateAt: now,
  }

  try {
    const messages = messageAdapter.buildMessages([probeMessage], undefined, {
      protocol,
      reasoningHistory: resolveCatalogReasoningHistory({
        model,
        provider,
        protocol,
      }),
    })
    await llmAdapter.chat(messages, [], {
      model,
      provider,
      protocol,
      url,
      key,
      fullUrl: data.fullUrl === true,
      thinking: 'off',
      thinkingParams: resolveCatalogThinkingParams({
        model,
        provider,
        protocol,
        display: 'off',
      }),
      skipHooks: true,
    })
    return { ok: true }
  } catch (err) {
    const technicalMessage = err instanceof Error ? err.message : String(err)
    const error = connectionErrorMessage(err)
    logger.event(
      'utils.testConnection.error',
      {
        provider,
        protocol: protocol ?? 'legacy',
        model,
        error: technicalMessage,
        category: classifyError(err),
      },
      LogLevel.warn,
    )
    return { ok: false, error }
  }
}

function connectionErrorMessage(err: unknown): string {
  if (err instanceof ClassifiedError) return err.userMessage
  if (err instanceof Error && COMPLIANT_TRACE_PATTERN.test(err.message)) return err.message
  return friendlyMessage(classifyError(err), 'brain')
}

async function fetchOpenAIModels(
  url: string,
  key: string | undefined,
  provider: string,
  fullUrl: boolean,
): Promise<UtilsModelsResponseData> {
  // 前端可传空 key（Ollama/Mock 不需要、用户在脑设置里留空保存）。
  // 直接 `apiKey: ''` 会被 OpenAI SDK 抛英文 `Missing credentials...`，这里短路成中文友好提示。
  const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/)
  if (placeholderMatch) {
    return {
      models: [],
      error: `密钥占位符 $${placeholderMatch[1]} 未替换，请先在 .env 或环境变量里配置`,
    }
  }
  if (!key) {
    return {
      models: [],
      error:
        '未配置密钥（OpenAI 兼容服务一般需要 Authorization Bearer 头；本地 LM Studio / vLLM / Ollama OpenAI 模式等服务不校验，填任意非空字符串即可，如 `lm-studio`）',
    }
  }
  if (fullUrl) {
    // fullUrl=true：绕开 SDK（SDK 会拼 /models），原生 fetch 直接请求用户填写的 URL——
    // 实际请求 = 用户值本身，与 chat 的 fullUrl 语义一致（docs/agent/provider.md「URL 解析与端点拼接」）。
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    })
    if (!res.ok) throw new Error(`upstream ${res.status}`)
    const json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> }
    return {
      models: (json.data ?? []).map((m) => ({
        id: m.id,
        name: m.id,
        ownedBy: m.owned_by,
      })),
    }
  }
  // 未勾选：SDK 自拼 /models，baseURL 原样（版本段由用户填写，见 resolveProviderUrl）
  const client = new OpenAI({
    baseURL: resolveProviderUrl(provider, url, { fullUrl: false, kind: 'models' }),
    apiKey: key,
  })
  const response = await client.models.list()
  const models = response.data.map((m) => ({
    id: m.id,
    name: m.id,
    ownedBy: m.owned_by,
  }))
  // openai-node v6 对伪 200（200 + 非 JSON，如网关 SPA 回退页）不抛错：parse 层把非 JSON 体
  // 原样当文本返回，分页层 body.data || [] 兜成空数组，与「真返回空列表」不可区分
  // （docs/agent/provider.md「utils.models openai SDK 路径的空列表提示」）。空列表时显式提示
  // 最常见原因（地址缺版本段），让用户可自查；真返回空 data 的网关同样收到此提示，属可接受歧义。
  if (models.length === 0) {
    return {
      models: [],
      error:
        '未获取到任何模型：若地址缺少版本段（如 /v1），请在地址末尾补上后重试；也可直接手填模型名',
    }
  }
  return { models }
}

async function fetchOllamaModels(url: string): Promise<UtilsModelsResponseData> {
  const client = new Ollama({ host: url })
  const response = await client.list()
  return {
    models: (response.models ?? []).map((m) => ({
      id: m.name ?? m.model ?? '',
      name: m.name ?? m.model,
    })),
  }
}

/**
 * Anthropic 模型列表：双尝试（docs/agent/provider.md「anthropic 模型列表双尝试」）。
 * 主尝试 Anthropic 原生 GET {url}/models?limit=1000，header x-api-key + anthropic-version
 * （同 anthropic.ts 的 chat 路径鉴权方式）；版本前缀（如 /v1）由用户在 url 自己提供，
 * 与 joinAnthropicUrl 约定一致。非流式、无第三方 SDK。
 *
 * 回退：主尝试无模型产出且未勾选 fullUrl 时，按 OpenAI 兼容 GET {base}/models
 * （仅 Authorization Bearer）再试一次——网关两种协议 base 常不同、且可能只认 Bearer
 * （如 MiniMax）。两边均无产出 → error 聚合两段原因，诊断信息不打折。
 *
 * 错误策略：诊断接口需 Fail Loud，**不走外层 friendlyMessage 泛化**（会吞 status/snippet）。
 * 仅占位符/空 key 同 fetchOpenAIModels 早返模式。
 */
async function fetchAnthropicModels(
  url: string,
  key: string | undefined,
  fullUrl: boolean,
): Promise<UtilsModelsResponseData> {
  // 镜像 fetchOpenAIModels 的占位符/空 key 短路：Anthropic 公共 API 必须带 x-api-key。
  const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/)
  if (placeholderMatch) {
    return {
      models: [],
      error: `密钥占位符 $${placeholderMatch[1]} 未替换，请先在 .env 或环境变量里配置`,
    }
  }
  if (!key) {
    return {
      models: [],
      error:
        '未配置密钥（Anthropic API 需要 x-api-key；如使用自建代理且不校验密钥，填任意非空字符串即可）',
    }
  }

  const primary = await fetchAnthropicModelsNative(url, key, fullUrl)
  if (primary.models.length > 0) return primary
  // fullUrl=true：完全自负责，不做协议回退（回退 URL 无法从用户给的完整端点推导）
  if (fullUrl) return primary

  const fallback = await fetchOpenAICompatModelsFallback(url, key)
  if (fallback.models.length > 0) return fallback
  return {
    models: [],
    error: `${primary.error ?? 'Anthropic 原生 /models 未返回模型'}；OpenAI 兼容回退（GET /models + Bearer）亦失败：${fallback.error ?? '未返回模型'}`,
  }
}

/**
 * Anthropic 原生尝试：GET {url}/models?limit=1000（x-api-key + anthropic-version）。
 * 网络/HTTP/JSON 解析失败就地返回 {models:[], error} 携带真实 status+片段，不抛。
 */
async function fetchAnthropicModelsNative(
  url: string,
  key: string,
  fullUrl: boolean,
): Promise<UtilsModelsResponseData> {
  // models 端点走统一入口（拼 /models?limit=1000；fullUrl=true 原样访问，须含 /models，见
  // docs/agent/provider.md「URL 解析与端点拼接」）
  const modelsUrl = resolveProviderUrl('anthropic', url, { fullUrl, kind: 'models' })
  let res: Response
  try {
    res = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
    })
  } catch (err) {
    // 网络/DNS/连接失败：透传原始 message 供诊断（url 不可达、代理错等）
    const msg = err instanceof Error ? err.message : String(err)
    logger.event(
      'utils.models.error',
      { provider: 'anthropic', url, error: msg, category: 'network' },
      LogLevel.warn,
    )
    return {
      models: [],
      error: `连接 Anthropic 失败：${msg}（请检查 url 是否可达：${url}）`,
    }
  }
  if (!res.ok) {
    // 上游非 2xx：透传 status + 响应片段（401/403/400/404 等，诊断接口不吞细节）
    const snippet = await readErrorSnippet(res)
    const status = res.status
    const category =
      status === 401 || status === 403 ? 'auth' : status >= 500 ? 'provider' : 'unknown'
    logger.event(
      'utils.models.error',
      { provider: 'anthropic', url, error: `upstream ${status}: ${snippet}`, category },
      LogLevel.warn,
    )
    return {
      models: [],
      error: `Anthropic 接口返回 ${status}：${snippet}`,
    }
  }

  let json: { data?: Array<{ id: string; display_name?: string }>; has_more?: boolean }
  try {
    json = (await res.json()) as {
      data?: Array<{ id: string; display_name?: string }>
      has_more?: boolean
    }
  } catch (err) {
    // 200 但非 JSON（如错误页 HTML）：透传提示
    const msg = err instanceof Error ? err.message : String(err)
    logger.event(
      'utils.models.error',
      { provider: 'anthropic', url, error: `json parse: ${msg}`, category: 'unknown' },
      LogLevel.warn,
    )
    return {
      models: [],
      error: `Anthropic 返回了非 JSON 内容：url 可能缺版本段（如 /v1，请在地址末尾补上后重试）或未指向 API（当前：${url}）`,
    }
  }
  // has_more=true 表示超过 limit 被截断（Anthropic 模型目录远小于 1000，仅兜底可见性，不静默丢弃）
  if (json.has_more) {
    logger.event(
      'utils.models.truncated',
      { provider: 'anthropic', url, limit: 1000 },
      LogLevel.warn,
    )
  }
  return {
    models: (json.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name ?? m.id,
    })),
  }
}

/**
 * OpenAI 兼容回退尝试：GET {base}/models（仅 Authorization Bearer）。
 * `/models` 为 openai 兼容协议常量（与 /chat/completions 同款豁免，buildEndpointUrl 直拼，
 * 见 docs/standards/provider-url-resolution.md §4）。失败就地返回 {models:[], error}，不抛。
 */
async function fetchOpenAICompatModelsFallback(
  url: string,
  key: string,
): Promise<UtilsModelsResponseData> {
  const modelsUrl = buildEndpointUrl(url, { fullUrl: false, endpoint: '/models' })
  let res: Response
  try {
    res = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.event(
      'utils.models.error',
      { provider: 'anthropic', url, error: `fallback network: ${msg}`, category: 'network' },
      LogLevel.warn,
    )
    return { models: [], error: `连接失败：${msg}（GET ${modelsUrl}）` }
  }
  if (!res.ok) {
    const snippet = await readErrorSnippet(res)
    const status = res.status
    const category = status === 401 || status === 403 ? 'auth' : 'unknown'
    logger.event(
      'utils.models.error',
      {
        provider: 'anthropic',
        url,
        error: `fallback upstream ${status}: ${snippet}`,
        category,
      },
      LogLevel.warn,
    )
    return { models: [], error: `接口返回 ${status}：${snippet}` }
  }
  let json: { data?: Array<{ id: string; owned_by?: string }> }
  try {
    json = (await res.json()) as { data?: Array<{ id: string; owned_by?: string }> }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.event(
      'utils.models.error',
      { provider: 'anthropic', url, error: `fallback json parse: ${msg}`, category: 'unknown' },
      LogLevel.warn,
    )
    return {
      models: [],
      error: `返回了非 JSON 内容（GET ${modelsUrl}；url 可能缺版本段，请在地址末尾补上（如 /v1）后重试）`,
    }
  }
  return {
    models: (json.data ?? []).map((m) => ({
      id: m.id,
      name: m.id,
      ownedBy: m.owned_by,
    })),
  }
}

/**
 * env.list：返回 .env 文件中的变量名列表（供前端密钥下拉选择）。
 * 每次实时读盘；调用前覆盖式重载 .env → process.env，让运行期新增/修改的密钥立即生效
 * （前端点「刷新密钥」即触发，无需重启）。
 */
export async function handleEnvList(
  _ctx: HandlerContext,
  _data: EnvListRequestData,
): Promise<EnvListResponseData> {
  reloadEnvFile(true)
  // .env 已覆盖重载 → 失效 envGuard 模块级缓存（否则运行期新增/轮换的 key 与新值不被脱敏）
  resetEnvVarCache()
  return { vars: listEnvVarNames() }
}

/**
 * utils.openFile：打开指定文件（用配置的文本编辑器或系统默认）。
 * path：相对 CHERY_DIR 的文件路径（如 .env、.chery/config.yaml）。
 * 由后端进程使用配置的 textEditor 或系统默认应用打开。
 */
export async function handleUtilsOpenFile(
  _ctx: HandlerContext,
  data: UtilsOpenFileRequestData,
): Promise<UtilsOpenFileResponseData> {
  const cheryDir = getCheryDir()
  const filePath = join(cheryDir, data.path)

  // 优先使用配置的文本编辑器
  const textEditor = config.global.textEditor

  if (textEditor) {
    // 使用配置的编辑器打开文件
    const editor = replaceEnvVars(textEditor) as string
    logger.event('utils.openFile', { path: filePath, editor }, LogLevel.info)

    // 根据操作系统选择打开方式
    const platform = process.platform
    let command: string
    let args: string[]

    if (platform === 'win32') {
      // Windows: 直接使用编辑器命令
      command = editor
      args = [filePath]
    } else if (platform === 'darwin') {
      // macOS: 使用 open 命令
      if (editor === 'vscode' || editor.includes('Visual Studio Code')) {
        command = 'open'
        args = ['-a', 'Visual Studio Code', filePath]
      } else {
        command = 'open'
        args = ['-a', editor, filePath]
      }
    } else {
      // Linux: 直接使用编辑器命令
      command = editor
      args = [filePath]
    }

    // 注意：不带 windowsHide——编辑器多为 GUI 程序（notepad/vscode），windowsHide:true 会使其
    // 无窗口运行（回归 a3fd2c2）。控制台子进程（execute_command/hooks）仍按约定带 windowsHide 防 cmd 窗闪。
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', (err) => {
      logger.error(`utils.openFile: 启动编辑器失败 ${editor}: ${err.message}`)
    })
    child.unref()
  } else {
    logger.event('utils.openFile', { path: filePath, editor: 'system default' }, LogLevel.info)
    await openWithSystem(filePath)
  }

  return {}
}

/** utils.openConfigDir：固定打开后端主机的 CHERY_DIR/.chery 配置目录。 */
export async function handleUtilsOpenConfigDir(
  _ctx: HandlerContext,
  _data: UtilsOpenConfigDirRequestData,
): Promise<UtilsOpenConfigDirResponseData> {
  const configDir = join(getCheryDir(), '.chery')
  let isDirectory = false
  try {
    isDirectory = statSync(configDir).isDirectory()
  } catch {
    // 统一在下方返回包含实际目标路径的错误。
  }
  if (!isDirectory) {
    throw new Error(`配置目录不存在或不是目录: ${configDir}`)
  }

  logger.event('utils.openConfigDir', { path: configDir }, LogLevel.info)
  await openWithSystem(configDir)
  return {}
}

/**
 * 检测系统可用的文本编辑器。
 * Windows: VSCode (code)、记事本 (notepad)
 * macOS: VSCode (code)、TextEdit (系统自带)
 * Linux: VSCode (code)、gedit
 */
async function detectAvailableEditors(): Promise<
  Array<{ name: string; command: string; available: boolean }>
> {
  const platform = process.platform
  const editors: Array<{ name: string; command: string; available: boolean }> = []

  // VSCode 检测（跨平台）
  try {
    const vscodeCmd = platform === 'win32' ? 'where code' : 'which code'
    await exec(vscodeCmd, { timeout: 2000 })
    editors.push({ name: 'Visual Studio Code', command: 'code', available: true })
  } catch {
    editors.push({ name: 'Visual Studio Code', command: 'code', available: false })
  }

  if (platform === 'win32') {
    // Windows: 记事本（系统自带，始终可用）
    editors.push({ name: '记事本', command: 'notepad', available: true })
  } else if (platform === 'darwin') {
    // macOS: TextEdit（系统自带，始终可用）
    editors.push({ name: 'TextEdit', command: 'TextEdit', available: true })
  } else {
    // Linux: gedit 检测
    try {
      await exec('which gedit', { timeout: 2000 })
      editors.push({ name: 'gedit', command: 'gedit', available: true })
    } catch {
      editors.push({ name: 'gedit', command: 'gedit', available: false })
    }
  }

  return editors
}

/**
 * utils.editors：返回系统可用的文本编辑器列表（供前端下拉选择）。
 */
export async function handleUtilsEditors(
  _ctx: HandlerContext,
  _data: UtilsEditorsRequestData,
): Promise<UtilsEditorsResponseData> {
  const editors = await detectAvailableEditors()
  return { editors }
}

/**
 * utils.modelRecommendation：返回模型规则识别、事实、编辑器推荐和当前协议的 thinking 档位。
 * 未命中时档位为空；推荐只由前端写入草稿，运行时不会直接继承。
 */
export async function handleUtilsModelRecommendation(
  _ctx: HandlerContext,
  data: UtilsModelRecommendationRequestData,
): Promise<UtilsModelRecommendationResponseData> {
  try {
    const resolved = resolveModelCatalog({
      model: data.model,
      provider: data.provider,
      protocol: data.protocol,
    })
    return { ...resolved, thinkingLevels: [...resolved.thinkingLevels] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.event('utils.modelRecommendation.error', { error: message }, LogLevel.warn)
    return {
      matched: false,
      confidence: 'unknown',
      thinkingLevels: [],
      unknown: { capabilities: { toolCall: true } },
    }
  }
}

/**
 * 注册 Utils handlers
 */
export function registerUtilsHandlers(router: import('../message/router.js').RpcRouter): void {
  router.register(Method.UTILS_MODELS, handleUtilsModels)
  router.register(Method.UTILS_TEST_CONNECTION, handleUtilsTestConnection)
  router.register(Method.ENV_LIST, handleEnvList)
  router.register(Method.UTILS_OPEN_FILE, handleUtilsOpenFile)
  router.register(Method.UTILS_OPEN_CONFIG_DIR, handleUtilsOpenConfigDir)
  router.register(Method.UTILS_EDITORS, handleUtilsEditors)
  router.register(Method.UTILS_MODEL_RECOMMENDATION, handleUtilsModelRecommendation)
}
