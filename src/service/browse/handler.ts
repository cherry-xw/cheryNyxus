/**
 * 文件夹浏览协议 handler（config.workspace.browse.start / .list）。
 *
 * 加密：每 list 请求客户端生成一次性 hex nonce，encPath = xorEncrypt(nonce, 路径)；
 * 服务端解密 → 沙箱 → 以同一 nonce 加密载荷回传。混淆级（nonce 明文随请求），
 * 防被动嗅探/日志明文泄漏；**绝不把浏览路径写入日志**（加密的意义所在）。
 *
 * 预期失败（越界/无权限/会话失效）返回结构化载荷而非 RpcError，与
 * handleConfigWorkspaceValidate 惯例一致；仅真正的内部错误经 router 转 RpcError。
 */
import type { RpcRouter, HandlerContext } from '../message/router.js'
import {
  Method,
  type ConfigWorkspaceBrowseStartRequestData,
  type ConfigWorkspaceBrowseStartResponseData,
  type ConfigWorkspaceBrowseListRequestData,
  type ConfigWorkspaceBrowseListResponseData,
} from '../message/types.js'
import { xorEncrypt, xorDecrypt } from '@/utils/obfuscate.js'
import { effectiveBrowseRoots, listBrowseEntries, sepFor } from './sandbox.js'
import { browseSessions } from './session.js'
import config from '@/utils/config.js'

const DEFAULT_TTL_MS = 600_000
const DEFAULT_RPM = 60
const DEFAULT_MAX_SESSIONS = 20

/**
 * includeFiles 生效值 = 配置 default_include_files 为硬上限：
 * 配置 false → 恒 false（调用方传 true 也被忽略）；配置 true → 缺省 true、可被调用方覆盖为 false。
 */
function effectiveIncludeFiles(clientValue: boolean | undefined): boolean {
  const allowFiles = config.server.workspace_browse?.default_include_files === true
  if (!allowFiles) return false
  return clientValue ?? true
}

function startError(error: string): ConfigWorkspaceBrowseStartResponseData {
  return {
    sessionId: '',
    ttlMs: 0,
    platform: process.platform,
    sep: sepFor(process.platform),
    roots: [],
    initialPath: '',
    includeFiles: false,
    error,
  }
}

/** config.workspace.browse.start：开启浏览会话（根白名单 + sessionId + TTL + 限流）。 */
async function handleBrowseStart(
  _ctx: HandlerContext,
  _data: ConfigWorkspaceBrowseStartRequestData,
): Promise<ConfigWorkspaceBrowseStartResponseData> {
  const cfg = config.server.workspace_browse
  const roots = effectiveBrowseRoots()
  if (!roots.length) return startError('未配置可浏览的根目录')

  const { session, error } = browseSessions.create(
    roots,
    cfg?.session_ttl_ms ?? DEFAULT_TTL_MS,
    cfg?.rpm ?? DEFAULT_RPM,
    cfg?.max_sessions ?? DEFAULT_MAX_SESSIONS,
  )
  if (!session) return startError(error ?? '无法创建浏览会话')

  return {
    sessionId: session.id,
    ttlMs: cfg?.session_ttl_ms ?? DEFAULT_TTL_MS,
    platform: process.platform,
    sep: sepFor(process.platform),
    roots,
    initialPath: roots.length === 1 ? roots[0]!.path : '',
    includeFiles: effectiveIncludeFiles(undefined),
  }
}

/** config.workspace.browse.list：解密路径 → 沙箱列目录 → 同 nonce 加密回传。 */
async function handleBrowseList(
  _ctx: HandlerContext,
  data: ConfigWorkspaceBrowseListRequestData,
): Promise<ConfigWorkspaceBrowseListResponseData> {
  // 会话失效/限流：仍以请求 nonce 加密错误载荷回传（客户端解密路径一致）
  const consumed = browseSessions.consume(data.sessionId)
  if (!consumed.ok) {
    const error =
      consumed.reason === 'rate_limited'
        ? '请求过于频繁，请稍后重试'
        : '浏览会话无效或已过期，请重新打开'
    const payload = JSON.stringify({ path: '', accessible: false, error })
    return { nonce: data.nonce, encData: xorEncrypt(data.nonce, payload) }
  }

  const rawPath = xorDecrypt(data.nonce, data.encPath)
  const cfg = config.server.workspace_browse
  const payload = listBrowseEntries(rawPath, {
    roots: consumed.session.roots,
    includeFiles: effectiveIncludeFiles(data.includeFiles),
    showHidden: cfg?.show_hidden === true,
    maxDepth: cfg?.max_depth,
  })
  return { nonce: data.nonce, encData: xorEncrypt(data.nonce, JSON.stringify(payload)) }
}

export function registerBrowseHandlers(router: RpcRouter): void {
  router.register(Method.CONFIG_WORKSPACE_BROWSE_START, handleBrowseStart)
  router.register(Method.CONFIG_WORKSPACE_BROWSE_LIST, handleBrowseList)
}
