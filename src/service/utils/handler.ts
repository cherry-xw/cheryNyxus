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
  type UtilsThinkingLevelsRequestData,
  type UtilsThinkingLevelsResponseData,
} from '../message/types.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'
import { replaceEnvVars, listEnvVarNames, reloadEnvFile, getCheryDir } from '@/utils/config.js'
import config from '@/utils/config.js'
import { resolveThinkingLevelsBatch } from '@/utils/modelThinking.js'
import {
  ClassifiedError,
  COMPLIANT_TRACE_PATTERN,
  classifyError,
  friendlyMessage,
} from '@/utils/error.js'
import { getLLMAdapter } from '@/core/llm/adapter.js'
import { getMessageAdapter, type LLMResponse } from '@/core/message/adapter.js'
import { openWithSystem } from './openWithSystem.js'
import { readErrorSnippet } from '@/agent/provider/fetchBase.js'
import { ANTHROPIC_VERSION } from '@/agent/provider/anthropic.js'

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
  const url = replaceEnvVars(data.url) as string
  const key = data.key ? (replaceEnvVars(data.key) as string) : undefined

  try {
    switch (provider) {
      case 'openai':
      case 'deepseek':
        return await fetchOpenAIModels(url, key)
      case 'ollama':
        return await fetchOllamaModels(url)
      case 'anthropic':
        return await fetchAnthropicModels(url, key)
      default:
        return {
          models: [],
          error: `不支持的 provider: ${provider}（当前支持 openai / ollama / anthropic）`,
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
  if (provider === 'mock') {
    return { ok: false, error: 'mock 是离线模拟，无需测试连接' }
  }

  const llmAdapter = getLLMAdapter(provider)
  const messageAdapter = getMessageAdapter(provider)
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
    const messages = messageAdapter.buildMessages([probeMessage])
    await llmAdapter.chat(messages, [], {
      model,
      url,
      key,
      thinking: 'off',
      skipHooks: true,
    })
    return { ok: true }
  } catch (err) {
    const technicalMessage = err instanceof Error ? err.message : String(err)
    const error = connectionErrorMessage(err)
    logger.event(
      'utils.testConnection.error',
      { provider, model, error: technicalMessage, category: classifyError(err) },
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

async function fetchOpenAIModels(url: string, key?: string): Promise<UtilsModelsResponseData> {
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
  const client = new OpenAI({ baseURL: url, apiKey: key })
  const response = await client.models.list()
  return {
    models: response.data.map((m) => ({
      id: m.id,
      name: m.id,
      ownedBy: m.owned_by,
    })),
  }
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
 * Anthropic 模型列表：原生 fetch GET {url}/models?limit=1000
 * header x-api-key + anthropic-version（同 anthropic.ts 的 chat 路径鉴权方式）。
 * 版本前缀（如 /v1）由用户在 url 自己提供，与 joinAnthropicUrl 约定一致。
 * 非流式、无第三方 SDK（Anthropic 无官方 SDK 依赖）。
 *
 * 错误策略：诊断接口需 Fail Loud，**不走外层 friendlyMessage 泛化**（会吞 status/snippet）。
 * 网络/HTTP/JSON 解析三类失败就地返回 {models:[], error} 携带真实 status+片段，
 * 仅占位符/空 key 同 fetchOpenAIModels 早返模式。
 */
async function fetchAnthropicModels(url: string, key?: string): Promise<UtilsModelsResponseData> {
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

  const modelsUrl = `${url.replace(/\/+$/, '')}/models?limit=1000`
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
      error: `Anthropic 返回了非 JSON 内容（检查 url 是否指向正确的 API：${url}）`,
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
 * env.list：返回 .env 文件中的变量名列表（供前端密钥下拉选择）。
 * 每次实时读盘；调用前覆盖式重载 .env → process.env，让运行期新增/修改的密钥立即生效
 * （前端点「刷新密钥」即触发，无需重启）。
 */
export async function handleEnvList(
  _ctx: HandlerContext,
  _data: EnvListRequestData,
): Promise<EnvListResponseData> {
  reloadEnvFile(true)
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

    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
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
 * utils.thinkingLevels：按模型名批量查询 ThinkingLevel 档位列表。
 * 来源：[modelThinking.ts](../../utils/modelThinking.ts) 加载的 `.chery/model-thinking.yaml`。
 * 未命中或配置缺失 → 兜底返回 `["off", "on"]`。
 * 失败不抛错（仍返回部分结果 + 全量兜底），前端总能拿到有效档位。
 */
export async function handleUtilsThinkingLevels(
  _ctx: HandlerContext,
  data: UtilsThinkingLevelsRequestData,
): Promise<UtilsThinkingLevelsResponseData> {
  try {
    const levels = resolveThinkingLevelsBatch(data.models ?? [])
    // 展开 readonly → 可变数组（响应 DTO 用 mutable ThinkingLevel[]）
    const mutable: Record<string, import('@/core/llm/adapter.js').ThinkingLevel[]> = {}
    for (const [k, v] of Object.entries(levels)) {
      mutable[k] = [...v]
    }
    return { levels: mutable }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.event('utils.thinkingLevels.error', { error: message }, LogLevel.warn)
    // 兜底：所有 model 给 ["off", "on"]
    const fallback: Record<string, import('@/core/llm/adapter.js').ThinkingLevel[]> = {}
    for (const m of data.models ?? []) {
      if (typeof m === 'string' && m.length > 0) fallback[m] = ['off', 'on']
    }
    return { levels: fallback }
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
  router.register(Method.UTILS_THINKING_LEVELS, handleUtilsThinkingLevels)
}
