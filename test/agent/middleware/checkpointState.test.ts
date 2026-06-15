/**
 * CheckpointState 单元测试（纯单元，无集成依赖）。
 *
 * 覆盖：
 * - ingest 累积 stream thinking/content/senseDelta
 * - ingest 收集 sense_accept/sense_reject
 * - flushAssistant：构建+push assistant（sense_end 增量路径），幂等，空内容返回 null
 * - appendResponseMessages：未 flushed 构建 assistant；sense result 创建/更新；recovery 原地更新
 * - mergeSenseDeltas：按 index 合并 arguments（经 flushAssistant senseCalls 验证）
 */
import { describe, it, expect } from "vitest";
import { CheckpointState } from "@/agent/middleware/checkpointState.js";
import type {
  StreamChunk,
  SenseAcceptChunk,
  SenseRejectChunk,
} from "@/core/middleware/types.js";
import { createMockContext } from "../helpers/fakeContext.js";

function stream(opts: {
  thinking?: string;
  content?: string;
  senseDelta?: StreamChunk["senseDelta"];
}): StreamChunk {
  return {
    type: "stream",
    thinkingDelta: opts.thinking ?? "",
    contentDelta: opts.content ?? "",
    senseDelta: opts.senseDelta,
  };
}

describe("CheckpointState.ingest", () => {
  it("累积 stream thinking 与 content", () => {
    const s = new CheckpointState();
    s.ingest(stream({ thinking: "a" }));
    s.ingest(stream({ thinking: "b", content: "x" }));
    s.ingest(stream({ content: "y" }));
    expect(s.getThinking()).toBe("ab");
    expect(s.getContent()).toBe("xy");
  });

  it("收集 senseDelta", () => {
    const s = new CheckpointState();
    s.ingest(stream({ senseDelta: [{ index: 0, id: "t1", name: "read_file", arguments: '{"a":' }] }));
    s.ingest(stream({ senseDelta: [{ index: 0, arguments: "1}" }] }));
    const ctx = createMockContext({ messages: [] });
    const msg = s.flushAssistant(ctx);
    expect(msg?.senseCalls?.[0]?.arguments).toBe('{"a":1}');
    expect(msg?.senseCalls?.[0]?.name).toBe("read_file");
  });

  it("收集 sense_accept / sense_reject 到 results", () => {
    const s = new CheckpointState();
    const accept: SenseAcceptChunk = { type: "sense_accept", id: "s1", name: "read_file", result: "ok", hash: "h1" };
    const reject: SenseRejectChunk = { type: "sense_reject", id: "s2", name: "write_file", reason: "no" };
    s.ingest(accept);
    s.ingest(reject);
    const ctx = createMockContext({ messages: [] });
    const mutations = s.appendResponseMessages(ctx);
    const created = mutations.filter((m) => m.type === "created");
    expect(created.length).toBe(2);
  });
});

describe("CheckpointState.flushAssistant", () => {
  it("有 content 时构建 assistant 消息并 push", () => {
    const s = new CheckpointState();
    s.ingest(stream({ thinking: "th", content: "co" }));
    const ctx = createMockContext({ messages: [] });
    const msg = s.flushAssistant(ctx);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("assistant");
    expect(msg!.content).toBe("co");
    expect(msg!.thinking).toBe("th");
    expect(ctx.soul.messages!.length).toBe(1);
    expect(ctx.soul.messages![0]!.role).toBe("assistant");
  });

  it("空内容返回 null 且不 push", () => {
    const s = new CheckpointState();
    const ctx = createMockContext({ messages: [] });
    expect(s.flushAssistant(ctx)).toBeNull();
    expect(ctx.soul.messages!.length).toBe(0);
  });

  it("幂等：已 flushed 后再调返回 null", () => {
    const s = new CheckpointState();
    s.ingest(stream({ content: "x" }));
    const ctx = createMockContext({ messages: [] });
    expect(s.flushAssistant(ctx)).not.toBeNull();
    expect(s.flushAssistant(ctx)).toBeNull();
    expect(ctx.soul.messages!.length).toBe(1);
  });

  it("senseCalls 由 senseDelta 合并", () => {
    const s = new CheckpointState();
    s.ingest(stream({ content: "c", senseDelta: [{ index: 0, id: "i1", name: "read_file", arguments: "{}" }] }));
    const ctx = createMockContext({ messages: [] });
    const msg = s.flushAssistant(ctx);
    expect(msg!.senseCalls?.length).toBe(1);
    expect(msg!.senseCalls?.[0]?.name).toBe("read_file");
  });
});

describe("CheckpointState.appendResponseMessages", () => {
  it("未 flushed 且有 content → created assistant", () => {
    const s = new CheckpointState();
    s.ingest(stream({ content: "hello" }));
    const ctx = createMockContext({ messages: [] });
    const mutations = s.appendResponseMessages(ctx);
    expect(mutations.some((m) => m.type === "created" && m.message.role === "assistant")).toBe(true);
    expect(ctx.soul.messages!.some((m) => m.role === "assistant" && m.content === "hello")).toBe(true);
  });

  it("已 flushed → 不重复 push assistant", () => {
    const s = new CheckpointState();
    s.ingest(stream({ content: "x" }));
    const ctx = createMockContext({ messages: [] });
    s.flushAssistant(ctx);
    const before = ctx.soul.messages!.length;
    const mutations = s.appendResponseMessages(ctx);
    expect(ctx.soul.messages!.length).toBe(before);
    expect(mutations.filter((m) => m.type === "created" && m.message.role === "assistant")).toHaveLength(0);
  });

  it("sense_accept result（新）→ created sense 消息", () => {
    const s = new CheckpointState();
    s.ingest({ type: "sense_accept", id: "new-sense", name: "read_file", result: "file-content", hash: "h" } as SenseAcceptChunk);
    const ctx = createMockContext({ messages: [] });
    const mutations = s.appendResponseMessages(ctx);
    const created = mutations.find((m) => m.type === "created" && m.message.role === "sense");
    expect(created).toBeDefined();
    expect(ctx.soul.messages!.some((m) => m.id === "new-sense" && m.role === "sense")).toBe(true);
  });

  it("sense result 已存在（recovery）→ updated 原地更新", () => {
    const s = new CheckpointState();
    s.ingest({ type: "sense_accept", id: "exist-sense", name: "read_file", result: "recovered", hash: "h2" } as SenseAcceptChunk);
    const ctx = createMockContext({
      messages: [{ id: "exist-sense", role: "sense", content: "", createdAt: 0, updateAt: 0 }],
    });
    const mutations = s.appendResponseMessages(ctx);
    const updated = mutations.find((m) => m.type === "updated" && m.id === "exist-sense");
    expect(updated).toBeDefined();
    expect(ctx.soul.messages!.find((m) => m.id === "exist-sense")!.content).toBe("recovered");
  });

  it("sense_reject → content 为「被拒绝: reason」", () => {
    const s = new CheckpointState();
    s.ingest({ type: "sense_reject", id: "rej", name: "write_file", reason: "危险" } as SenseRejectChunk);
    const ctx = createMockContext({ messages: [] });
    const mutations = s.appendResponseMessages(ctx);
    const created = mutations.find((m) => m.type === "created" && m.message.role === "sense") as
      | { type: "created"; message: { content?: string } }
      | undefined;
    expect(created?.message.content).toBe("被拒绝: 危险");
  });

  it("无任何内容 → 空 mutations", () => {
    const s = new CheckpointState();
    const ctx = createMockContext({ messages: [] });
    expect(s.appendResponseMessages(ctx)).toHaveLength(0);
  });
});

describe("mergeSenseDeltas（经 flushAssistant 验证）", () => {
  it("同 index 多 delta 累积 arguments，首 delta 提供 id/name", () => {
    const s = new CheckpointState();
    s.ingest(stream({ content: "c", senseDelta: [{ index: 0, id: "t0", name: "read_file", arguments: '{"p":' }] }));
    s.ingest(stream({ senseDelta: [{ index: 0, arguments: '"x"}' }] }));
    const ctx = createMockContext({ messages: [] });
    const msg = s.flushAssistant(ctx);
    expect(msg!.senseCalls).toEqual([{ id: "t0", name: "read_file", arguments: '{"p":"x"}' }]);
  });

  it("多 index → 多 senseCall，按 index 排序", () => {
    const s = new CheckpointState();
    s.ingest(stream({
      content: "c",
      senseDelta: [
        { index: 1, id: "t1", name: "write_file", arguments: "{}" },
        { index: 0, id: "t0", name: "read_file", arguments: "{}" },
      ],
    }));
    const ctx = createMockContext({ messages: [] });
    const msg = s.flushAssistant(ctx);
    expect(msg!.senseCalls?.map((sc) => sc.name)).toEqual(["read_file", "write_file"]);
  });
});
