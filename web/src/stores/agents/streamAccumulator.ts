/**
 * agents store 无闭包依赖纯函数。
 * 从 stores/agents.ts 抽离（重构）：routeChunk/routeNotification 调用的纯逻辑分离。
 * - accumulateStaged：staged 历史回放累积（入参 stream + d，操作 stream.history）
 * - sameRuntime：runtime 同值判定（纯比较）
 * - defaultBounds：舞台尺寸默认值（纯函数）
 */

import type { RuntimeSelection } from "@/services/agentApi";
import type { StageBounds } from "@/features/pets/types";
import type { StreamState, StagedChunkData } from "./types";
import { extractMediaUrls } from "@/utils/markdown";

export function defaultBounds(): StageBounds {
  return {
    width: typeof window !== "undefined" ? window.innerWidth : 960,
    height: typeof window !== "undefined" ? window.innerHeight : 640,
  };
}

/** 同 runtime 判定（brain + senseGroup + mcpServers 集合相同）。 */
export function sameRuntime(a: RuntimeSelection, b: RuntimeSelection): boolean {
  if (a.brain !== b.brain) return false;
  if (a.senseGroup !== b.senseGroup) return false;
  const am = [...(a.mcpServers ?? [])].sort();
  const bm = [...(b.mcpServers ?? [])].sort();
  return am.length === bm.length && am.every((v, i) => v === bm[i]);
}

/**
 * staged 历史回放累积：按 row 顺序重组为 HistoryItem[]。
 * 边界处理：role=sense content_end 按 id 匹配最近 senseCall 的 result（walk back）。
 * 角色（子 pet）检测：role=user 且 content 匹配 ^\[角色|子agent <type>\] → 归类 role（UI 标子 pet）。双前缀兼容旧 DB 消息。
 */
export function accumulateStaged(stream: StreamState, d: StagedChunkData | undefined): void {
  if (!d || !d.type) return;
  const history = stream.history;

  if (d.type === "thinking_end") {
    // 新 assistant 行：thinking 总是行首 emit（若存在），开新 item
    history.push({
      role: "assistant",
      content: "",
      thinking: d.thinking ?? "",
      createdAt: d.createdAt,
      msgId: d.msgId,
    });
    return;
  }

  if (d.type === "content_end") {
    const role = d.role;
    if (role === "user") {
      const content = d.content ?? "";
      const m = /^\[(?:子agent|角色)\s+([^\]]+?)\]/.exec(content);
      const mediaAssets = extractMediaUrls(content);
      if (m) {
        history.push({ role: "role", content, petName: m[1], runtime: d.runtime, createdAt: d.createdAt, msgId: d.msgId, ...(mediaAssets.length > 0 && { mediaAssets }) });
      } else {
        history.push({ role: "user", content, runtime: d.runtime, createdAt: d.createdAt, msgId: d.msgId, ...(mediaAssets.length > 0 && { mediaAssets }) });
      }
      return;
    }
    if (role === "assistant") {
      // 同行 thinking_end 已 push 过 item → last 是 assistant 且 content 空 → 填入；
      // 否则（行无 thinking，content_end 单独到）→ 新 item
      const content = d.content ?? "";
      const mediaAssets = extractMediaUrls(content);
      const last = history[history.length - 1];
      if (last && last.role === "assistant" && !last.content) {
        last.content = content;
        last.runtime = d.runtime;
        last.createdAt = d.createdAt ?? last.createdAt;
        if (mediaAssets.length > 0) last.mediaAssets = mediaAssets;
      } else {
        history.push({ role: "assistant", content, runtime: d.runtime, createdAt: d.createdAt, msgId: d.msgId, ...(mediaAssets.length > 0 && { mediaAssets }) });
      }
      return;
    }
    if (role === "sense") {
      // sense 执行结果（content_end role=sense id=X）→ 优先按 id 精确匹配；旧 staged 无 id 时退化为最近 result=undefined 项
      if (!d.id) return;
      for (let i = history.length - 1; i >= 0; i--) {
        const item = history[i];
        if (!item?.senseCalls) continue;
        // 优先按 id 精确匹配；缺 id 项退化为 result=undefined（向后兼容旧 staged）
        let sc = item.senseCalls.find((s) => s.id === d.id && s.result === undefined);
        if (!sc) sc = item.senseCalls.find((s) => s.id === undefined && s.result === undefined);
        if (!sc) sc = item.senseCalls.find((s) => s.result === undefined);
        if (sc) {
          sc.result = d.content;
          // 从 result 提取媒体资产
          if (typeof d.content === "string") {
            const mediaAssets = extractMediaUrls(d.content);
            if (mediaAssets.length > 0) sc.mediaAssets = mediaAssets;
          }
          return;
        }
      }
      return;
    }
    if (role === "role" || role === "subagent") {
      // T9：wait=true 子完成注入的回复（后端 role:role/subagent）。该消息保留为主 chat
      // 原始记录；与子 chat 的相同响应仅在 HistoryDrawer 的展示层安全合并。
      const content = d.content ?? "";
      const m = /^\[(?:子agent|角色)\s+([^\]]+?)\]/.exec(content);
      history.push({ role: "role", content, petName: m?.[1], runtime: d.runtime, createdAt: d.createdAt, msgId: d.msgId });
      return;
    }
    // role=system / role=undefined：暂不展示（CP4 不渲染 system 消息），忽略
    return;
  }

  if (d.type === "sense_end") {
    // 挂当前 assistant item；若无（仅 sense 无 assistant 行——异常序），fail loud warn
    const last = history[history.length - 1];
    if (!last || last.role !== "assistant") {
      console.warn("[agents] staged sense_end 无所属 assistant item", d);
      return;
    }
    if (!last.senseCalls) last.senseCalls = [];
    last.senseCalls.push({
      id: d.id,                       // sense message.id（与后端 LLMResponse.id 对齐）
      name: d.senseName ?? "",
      args: d.arguments,
      status: "done",
    });
    return;
  }

  // d.type === "reverse"：消息撤回（chat.resume 场景），CP4 历史回放暂不处理
}
