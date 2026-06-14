/**
 * 事件流断言辅助：把 S2C 事件分类（notification / staged / stream）便于断言。
 *
 * 三类事件顶层结构（见 docs/websocket.md）：
 * - notification: {kind:"notification", type:"consumed"|...}        ← type 在顶层
 * - staged chunk: {kind:"chunk", type:"staged", data:{type:"thinking_end"|...}}  ← 真实 type 在 data
 * - stream chunk: {kind:"chunk", type:"stream", seq, data:{content|thinking|senseCall}}
 */
import type { S2CEvent } from "./rpcClient.js";

export interface EventSummary {
  notifications: string[];
  staged: string[];
  streamCount: number;
  raw: S2CEvent[];
}

interface NotificationLike {
  kind: "notification";
  type: string;
  data: unknown;
}
interface StagedLike {
  kind: "chunk";
  type: "staged";
  data: { type: string; [k: string]: unknown };
}
interface StreamLike {
  kind: "chunk";
  type: "stream";
  seq: number;
  data: Record<string, unknown>;
}

function isNotification(e: S2CEvent): e is NotificationLike {
  return e.kind === "notification";
}
function isStaged(e: S2CEvent): e is StagedLike {
  return e.kind === "chunk" && (e as { type: string }).type === "staged";
}
function isStream(e: S2CEvent): e is StreamLike {
  return e.kind === "chunk" && (e as { type: string }).type === "stream";
}

export function summarize(events: S2CEvent[]): EventSummary {
  return {
    notifications: events.filter(isNotification).map((e) => e.type),
    staged: events.filter(isStaged).map((e) => e.data.type),
    streamCount: events.filter(isStream).length,
    raw: events,
  };
}

/** 找首个指定类型的 notification */
export function findNotification(events: S2CEvent[], type: string): NotificationLike | undefined {
  return events.filter(isNotification).find((e) => e.type === type);
}

/** 找首个指定 staged type 的 chunk */
export function findStaged(events: S2CEvent[], type: string): StagedLike | undefined {
  return events.filter(isStaged).find((e) => e.data.type === type);
}

/** 拼接所有 stream chunk 的 content 增量 */
export function collectStreamContent(events: S2CEvent[]): string {
  return events
    .filter(isStream)
    .map((e) => (e.data.content as string) ?? "")
    .join("");
}
