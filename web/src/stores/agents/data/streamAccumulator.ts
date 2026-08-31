/**
 * agents store 无闭包依赖纯函数。
 * 从 stores/agents.ts 抽离（重构）：routeChunk/routeNotification 调用的纯逻辑分离。
 * - accumulateStaged：staged 历史回放累积（入参 stream + d，操作 stream.history）
 * - sameRuntime：runtime 同值判定（纯比较）
 * - defaultBounds：舞台尺寸默认值（纯函数）
 */

import type { RuntimeSelection } from '@/services/agentApi'
import type { StageBounds } from '@/domain/pets/types'
import type { HistoryItem, StreamState, StagedChunkData } from '../types'
import { extractMediaUrls } from '@/utils/markdown'

export function defaultBounds(): StageBounds {
  return {
    width: typeof window !== 'undefined' ? window.innerWidth : 960,
    height: typeof window !== 'undefined' ? window.innerHeight : 640,
  }
}

/** 同 runtime 判定（brain + senseGroup + mcpServers 集合相同）。 */
export function sameRuntime(a: RuntimeSelection, b: RuntimeSelection): boolean {
  if (a.brain !== b.brain) return false
  if (a.senseGroup !== b.senseGroup) return false
  const am = [...(a.mcpServers ?? [])].sort()
  const bm = [...(b.mcpServers ?? [])].sort()
  return am.length === bm.length && am.every((v, i) => v === bm[i])
}

/**
 * staged 历史回放累积：按 row 顺序重组为 HistoryItem[]。
 * 边界处理：role=sense content_end 按 id 匹配最近 senseCall 的 result（walk back）。
 * 角色（子 pet）检测：role=user 且 content 匹配 ^\[角色|子agent <type>\] → 归类 role（UI 标子 pet）。双前缀兼容旧 DB 消息。
 */
export function accumulateStaged(stream: StreamState, d: StagedChunkData | undefined): void {
  if (!d || !d.type) return
  const history = stream.history

  if (d.type === 'reverse') {
    const revokedIds = new Set(d.messageIds ?? [])
    if (revokedIds.size === 0) return
    stream.history = history.filter((item) => !item.msgId || !revokedIds.has(item.msgId))
    if (stream.activeMessageId && revokedIds.has(stream.activeMessageId)) {
      stream.activeMessageId = undefined
      stream.thinking = ''
      stream.content = ''
    }
    return
  }

  if (d.type === 'thinking_end') {
    // 去重：done.finalMessage 已按 msgId push 过（streamRouter.ts 经 pushHistoryItem 统一入口）
    // → 合并到既有 item，不 push 新 item。否则 chat.sync staged 回放会产出两条同 msgId
    // assistant item（thinking 重复显示）。
    if (d.msgId) {
      const existing = history.find((h) => h.msgId === d.msgId)
      if (existing) {
        if (!existing.thinking) existing.thinking = d.thinking ?? ''
        if (d.createdAt) existing.createdAt = d.createdAt
        if (d.agentChatId) existing.agentChatId = d.agentChatId
        return
      }
    }
    // 新 assistant 行：thinking 总是行首 emit（若存在），开新 item
    history.push({
      role: 'assistant',
      content: '',
      thinking: d.thinking ?? '',
      createdAt: d.createdAt,
      msgId: d.msgId,
      ...(d.agentChatId ? { agentChatId: d.agentChatId } : {}),
    })
    return
  }

  if (d.type === 'content_end') {
    const role = d.role
    if (role === 'user') {
      const content = d.content ?? ''
      const m = /^\[(?:子agent|角色)\s+([^\]]+?)\]/.exec(content)
      const mediaAssets = extractMediaUrls(content)
      if (m) {
        history.push({
          role: 'role',
          content,
          petName: m[1],
          runtime: d.runtime,
          createdAt: d.createdAt,
          msgId: d.msgId,
          ...(d.agentChatId ? { agentChatId: d.agentChatId } : {}),
          ...(mediaAssets.length > 0 && { mediaAssets }),
        })
      } else {
        history.push({
          role: 'user',
          content,
          runtime: d.runtime,
          createdAt: d.createdAt,
          msgId: d.msgId,
          ...(d.agentChatId ? { agentChatId: d.agentChatId } : {}),
          ...(mediaAssets.length > 0 && { mediaAssets }),
        })
      }
      return
    }
    if (role === 'assistant') {
      const content = d.content ?? ''
      const mediaAssets = extractMediaUrls(content)
      // 同一消息（同 msgId）：thinking_end 已 push 过 item（或 done.finalMessage 已 push）→ 合并 content 进既有 item。
      // F4：done.finalMessage 经 pushHistoryItem 统一入口；pushHistoryItem 与 accumulateStaged 共享 msgId 幂等轴。
      // 不做跨行合并：多 loop turn 每个 loop 是独立消息（loop1=技能调用/thinking+senseCalls，loop2=正文），
      // 各自一条气泡，保持「先加载技能 → 下一 loop 回复」时序，避免 skill-box 被并进正文气泡（旧跨行合并所致）。
      if (d.msgId) {
        const existing = history.find((h) => h.msgId === d.msgId)
        if (existing) {
          if (!existing.content) {
            existing.content = content
            existing.runtime = d.runtime
            existing.createdAt = d.createdAt ?? existing.createdAt
            if (mediaAssets.length > 0) existing.mediaAssets = mediaAssets
            if (d.agentChatId) existing.agentChatId = d.agentChatId
            if (d.contextCompaction) existing.contextCompaction = true
            if (d.contextCompactionTokens !== undefined)
              existing.contextCompactionTokens = d.contextCompactionTokens
          }
          return
        }
      }
      history.push({
        role: 'assistant',
        content,
        runtime: d.runtime,
        createdAt: d.createdAt,
        msgId: d.msgId,
        ...(d.agentChatId ? { agentChatId: d.agentChatId } : {}),
        ...(d.contextCompaction ? { contextCompaction: true } : {}),
        ...(d.contextCompactionTokens !== undefined
          ? { contextCompactionTokens: d.contextCompactionTokens }
          : {}),
        ...(mediaAssets.length > 0 && { mediaAssets }),
      })
      return
    }
    if (role === 'sense') {
      // sense 执行结果（content_end role=sense id=X）→ 优先按 id 精确匹配；旧 staged 无 id 时退化为最近 result=undefined 项
      if (!d.id) return
      for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i]
        if (!item?.senseCalls) continue
        // 优先按 id 精确匹配；缺 id 项退化为 result=undefined（向后兼容旧 staged）
        let sc = item.senseCalls.find((s) => s.id === d.id && s.result === undefined)
        if (!sc) sc = item.senseCalls.find((s) => s.id === undefined && s.result === undefined)
        if (!sc) sc = item.senseCalls.find((s) => s.result === undefined)
        if (sc) {
          sc.result = d.content
          // 从 result 提取媒体资产
          if (typeof d.content === 'string') {
            const mediaAssets = extractMediaUrls(d.content)
            if (mediaAssets.length > 0) sc.mediaAssets = mediaAssets
          }
          return
        }
      }
      return
    }
    if (role === 'role' || role === 'subagent') {
      // T9：wait=true 子完成注入的回复（后端 role:role/subagent）。该消息保留为主 chat
      // 原始记录；与子 chat 的相同响应仅在 HistoryDrawer 的展示层安全合并。
      const content = d.content ?? ''
      const m = /^\[(?:子agent|角色)\s+([^\]]+?)\]/.exec(content)
      // role reply 实际由子 chat 生成：agentChatId = childChatId 才是真正的源头
      // （当前 StagedChunkData.agentChatId = 当前回放 chatId 即主 chat，故此处覆盖）
      history.push({
        role: 'role',
        content,
        petName: m?.[1],
        runtime: d.runtime,
        createdAt: d.createdAt,
        msgId: d.msgId,
      })
      return
    }
    // role=system / role=undefined：暂不展示（CP4 不渲染 system 消息），忽略
    return
  }

  if (d.type === 'sense_end') {
    // 幂等：同 id 已存在于任意 assistant item 的 senseCalls → 跳过。
    // 防回放重入 / WS 重投递致同一 sense call 被处理两次（skill-box 翻倍）。user content_end 无去重也未翻倍
    // 说明非均匀整流重放，故按 id 精确去重（而非按 msgId 重放级去重）。
    if (d.id) {
      for (const item of history) {
        const existing = item.senseCalls?.find((call) => call.id === d.id)
        if (!existing) continue
        if (!existing.security && d.security) existing.security = d.security
        return
      }
    }
    // 挂当前 assistant item；若无（仅 sense 无 assistant 行——异常序），fail loud warn
    const last = history[history.length - 1]
    if (!last || last.role !== 'assistant') {
      console.warn('[agents] staged sense_end 无所属 assistant item', d)
      return
    }
    if (!last.senseCalls) last.senseCalls = []
    // 缺 id（旧 staged）退化为 last 内 name+args 指纹去重
    if (
      !d.id &&
      last.senseCalls.some((s) => s.name === (d.senseName ?? '') && s.args === d.arguments)
    )
      return
    last.senseCalls.push({
      id: d.id, // sense message.id（与后端 LLMResponse.id 对齐）
      name: d.senseName ?? '',
      args: d.arguments,
      status: 'done',
      security: d.security,
    })
    return
  }

}

/**
 * 把已成型 HistoryItem 推入 `stream.history`，与 accumulateStaged 共享 msgId 幂等轴（C/D/E 源）。
 *
 * 边界（与 accumulateStaged 互补）：
 * - accumulateStaged 解析 `StagedChunkData` 行（B 源，chat.sync staged）→ 内部按 type 分流建/合 item
 * - pushHistoryItem 接收**已成型** item（C/D/E 源：done finalMessage / role_reply / sendMessage 乐观）→
 *   直接落库 + msgId 幂等补字段
 * - 两者写同一 `stream.history`，msgId 命中既有 → 就地补空字段；不存在 → push 新 item
 *
 * 实时轮打字机不走本函数（由 stream.thinking/content 暂存，双气泡契约；不并入 history 末项）。
 *
 * 媒体抽取（extractMediaUrls）由调用方在构造 item 前完成，本函数不重复抽取。
 */
export function pushHistoryItem(stream: StreamState, item: HistoryItem): void {
  const history = stream.history
  if (item.msgId) {
    const existing = history.find((h) => h.msgId === item.msgId)
    if (existing) {
      // 就地补空字段（已存在的不覆盖）
      if (!existing.content && item.content) existing.content = item.content
      if (!existing.thinking && item.thinking) existing.thinking = item.thinking
      // msgId 已命中即一致，无需补；agentChatId 缺则补（兜底）
      if (!existing.agentChatId && item.agentChatId) existing.agentChatId = item.agentChatId
      // senseCalls 合并（按 id 去重）
      if (item.senseCalls?.length) {
        const calls = [...(existing.senseCalls ?? [])]
        const fingerprints = new Set<string>()
        for (const sc of calls) {
          fingerprints.add(sc.id ? `id:${sc.id}` : `name:${sc.name}:${String(sc.args ?? '')}`)
        }
        for (const sc of item.senseCalls) {
          const fp = sc.id ? `id:${sc.id}` : `name:${sc.name}:${String(sc.args ?? '')}`
          if (fingerprints.has(fp)) continue
          fingerprints.add(fp)
          calls.push({ ...sc })
        }
        if (calls.length) existing.senseCalls = calls
      }
      return
    }
  }
  history.push(item)
}

/**
 * 实时把工具执行结果写入 stream.history 中对应 id 的 senseCall（accept/rejected notification 触发）。
 * 与 accumulateStaged 的 content_end role=sense 回放路径一致：倒序找 id 匹配项，填 result + mediaAssets；
 * 不改 status（与回放一致——回放只填 result，status 保持 sense_end 加入时的 'done'）。
 * 找不到（sense_end staged 未到 / 已 reload）→ 静默返回（reload 后权威结果补齐）。
 */
export function fillSenseResultInHistory(
  stream: StreamState,
  senseId: string,
  result: string,
): void {
  for (let i = stream.history.length - 1; i >= 0; i--) {
    const item = stream.history[i]
    if (!item?.senseCalls) continue
    const sc = item.senseCalls.find((s) => s.id === senseId)
    if (sc) {
      sc.result = result
      const mediaAssets = extractMediaUrls(result)
      if (mediaAssets.length > 0) sc.mediaAssets = mediaAssets
      return
    }
  }
}
