/**
 * senseMiddleware 测试（集成 + 单元）。
 *
 * 集成（真实洋葱链 + mock provider）：
 * - auto sense 直接执行 → sense_accept
 * - confirm accept：sense_pending → approve → sense_accept
 * - confirm reject：sense_pending → reject → sense_reject
 * - hash 去重：同 read_file 路径两次 → message_updated replace
 *
 * 单元（resume 续接）：
 * - resume pending：末尾 pending sense 在 senseTable → 执行 → sense_accept
 * - resume 工具不在 senseTable → 「无此工具」占位
 */
import { describe, it, expect, beforeAll } from "vitest";
import { senseMiddleware } from "@/agent/middleware/tool.js";
import type { MiddlewareChunk } from "@/core/middleware/types.js";
import {
  bootstrapForTests,
  createAgent,
  runSend,
  runSendWithApproval,
  runResume,
} from "../helpers/agentHarness.js";
import {
  collectChunks,
  senseAccepts,
  senseRejects,
  sensePendings,
  messageUpdated,
} from "../helpers/chunkAssert.js";
import { createMockContext, createMockRuntime, createTestSense, makeNext } from "../helpers/fakeContext.js";
import { addMockBrain, scriptItem } from "../helpers/mockScripts.js";
import { createTempDir, cleanupTempDir, createTempFile } from "../../helpers/tempDir.js";

describe("senseMiddleware 集成：auto 执行", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("auto sense（read_file:auto）直接执行 → sense_accept", async () => {
    const agent = createAgent({ brain: "mock_auto", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "读文件");
    // auto 不产生 sense_pending（无审批），直接 sense_accept
    expect(sensePendings(chunks)).toHaveLength(0);
    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1);
    expect(senseAccepts(chunks)[0]?.name).toBe("read_file");
  });

  it("auto 不等待审批即执行（无 sense_pending）", async () => {
    const agent = createAgent({ brain: "mock_auto", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "再读一次");
    const accept = senseAccepts(chunks)[0];
    expect(accept).toBeDefined();
    // read_file result 非空（执行结果或路径错误消息）
    expect(accept!.result.length).toBeGreaterThan(0);
  });
});

describe("senseMiddleware 集成：confirm 审批", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("confirm accept：sense_pending → approve → sense_accept", async () => {
    const agent = createAgent({ brain: "mock_confirm", senseGroups: ["confirm_senses"] });
    const chunks = await runSendWithApproval(agent, "写文件", () => "accept");
    const pending = sensePendings(chunks);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0]?.supervisionLevel).toBe(1); // confirm
    expect(pending[0]?.senseName).toBe("write_file");
    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1);
    expect(senseRejects(chunks)).toHaveLength(0);
  });

  it("confirm reject：sense_pending → reject → sense_reject", async () => {
    const agent = createAgent({ brain: "mock_confirm_reject", senseGroups: ["confirm_senses"] });
    const chunks = await runSendWithApproval(agent, "写文件", () => ({ action: "reject", reason: "危险操作" }));
    expect(sensePendings(chunks).length).toBeGreaterThanOrEqual(1);
    const rejects = senseRejects(chunks);
    expect(rejects.length).toBeGreaterThanOrEqual(1);
    expect(rejects[0]?.reason).toContain("危险操作");
  });
});

describe("senseMiddleware 集成：hash 去重", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("同 read_file 路径两次（mtime 不变）→ 第二次替换第一次（message_updated replace）", async () => {
    const dir = createTempDir();
    const filePath = createTempFile(dir, "dup.txt", "same content line\n");
    const brain = addMockBrain("hash-dedup", {
      repeat: "last",
      script: [
        scriptItem({
          content: "read first",
          senseCalls: [{ id: "hd-0", name: "read_file", arguments: JSON.stringify({ path: filePath }) }],
        }),
        scriptItem({
          senseCalls: [{ id: "hd-1", name: "read_file", arguments: JSON.stringify({ path: filePath }) }],
        }),
        scriptItem({ content: "done" }),
      ],
    });
    try {
      const agent = createAgent({ brain, senseGroups: ["auto_senses"] });
      const chunks = await runSend(agent, "读两次同文件");
      // 第二次同 hash 命中 → doExecuteSense 替换历史 sense msg → message_updated(replace.state=true)
      const replaced = messageUpdated(chunks).filter((u) => u.patch.replace?.state);
      expect(replaced.length).toBeGreaterThanOrEqual(1);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("senseMiddleware 单元：resume 续接", () => {
  it("resume pending（sense 在 senseTable）→ 执行 → sense_accept", async () => {
    const testSense = createTestSense("test_tool", async () => ({ content: "executed", hash: "" }));
    const ctx = createMockContext({
      resumePending: true,
      runtime: createMockRuntime({ senses: [testSense] }),
      messages: [
        { id: "m1", role: "assistant", content: "call", senseCalls: [{ id: "p1", name: "test_tool", arguments: "{}" }], createdAt: 0, updateAt: 0 },
        { id: "p1", role: "sense", content: "", senseCalls: [{ id: "p1", name: "test_tool", arguments: "{}" }], createdAt: 0, updateAt: 0 },
      ],
    });
    const out = await collectChunks(senseMiddleware(ctx, makeNext([])));
    expect(out.some((c) => c.type === "sense_accept")).toBe(true);
    const accept = senseAccepts(out)[0];
    expect(accept?.result).toBe("executed");
    // resumePending 标志被清除
    expect(ctx.soul.resumePending).toBe(false);
  });

  it("resume 工具不在 senseTable → 「无此工具」占位结果", async () => {
    const ctx = createMockContext({
      resumePending: true,
      runtime: createMockRuntime({ senses: [] }), // 空 senseTable
      messages: [
        { id: "p2", role: "sense", content: "", senseCalls: [{ id: "p2", name: "missing_tool", arguments: "{}" }], createdAt: 0, updateAt: 0 },
      ],
    });
    const out = await collectChunks(senseMiddleware(ctx, makeNext([])));
    const accept = senseAccepts(out)[0];
    expect(accept).toBeDefined();
    expect(accept!.result).toContain("无此工具");
    expect(accept!.name).toBe("missing_tool");
  });

  it("resume 无 pending sense → 无 sense_accept", async () => {
    const ctx = createMockContext({
      resumePending: true,
      runtime: createMockRuntime({ senses: [] }),
      messages: [
        { id: "done-sense", role: "sense", content: "already done", createdAt: 0, updateAt: 0 },
      ],
    });
    const out = await collectChunks(senseMiddleware(ctx, makeNext([]) as () => AsyncGenerator<MiddlewareChunk>));
    expect(senseAccepts(out)).toHaveLength(0);
  });
});
