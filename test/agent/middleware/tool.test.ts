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
import type { MiddlewareChunk, SensePendingChunk } from "@/core/middleware/types.js";
import {
  bootstrapForTests,
  createAgent,
  runSend,
  runSendWithApproval,
  runResume,
  approve,
  abortApproval,
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
import { AgentAbortError } from "@/core/middleware/errors.js";

describe("senseMiddleware 集成：auto 执行", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("auto sense（read_file:auto）直接执行 → sense_accept", async () => {
    const agent = createAgent({ brain: "mock_auto", senseGroup: "auto_senses" });
    const chunks = await runSend(agent, "读文件");
    // auto 不产生 sense_pending（无审批），直接 sense_accept
    expect(sensePendings(chunks)).toHaveLength(0);
    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1);
    expect(senseAccepts(chunks)[0]?.name).toBe("read_file");
  });

  it("auto 不等待审批即执行（无 sense_pending）", async () => {
    const agent = createAgent({ brain: "mock_auto", senseGroup: "auto_senses" });
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
    const agent = createAgent({ brain: "mock_confirm", senseGroup: "confirm_senses" });
    const chunks = await runSendWithApproval(agent, "写文件", () => "accept");
    const pending = sensePendings(chunks);
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0]?.supervisionLevel).toBe(1); // confirm
    expect(pending[0]?.senseName).toBe("write_file");
    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1);
    expect(senseRejects(chunks)).toHaveLength(0);
  });

  it("confirm reject：sense_pending → reject → sense_reject", async () => {
    const agent = createAgent({ brain: "mock_confirm_reject", senseGroup: "confirm_senses" });
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
      const agent = createAgent({ brain, senseGroup: "auto_senses" });
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
    expect(accept!.result).toContain("工具已失效");
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

describe("senseMiddleware 集成：批量审批 sequential（P1.9）", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("2 confirm call 混合 accept/reject → 1 accept + 1 reject，不 throw", async () => {
    const dir = createTempDir();
    const brain = addMockBrain("seq-mixed", {
      repeat: "last",
      script: [
        scriptItem({
          content: "两个写",
          senseCalls: [
            { id: "sm-0", name: "write_file", arguments: JSON.stringify({ path: `${dir}/a.txt`, content: "a" }) },
            { id: "sm-1", name: "write_file", arguments: JSON.stringify({ path: `${dir}/b.txt`, content: "b" }) },
          ],
        }),
        scriptItem({ content: "done" }),
      ],
    });
    try {
      const agent = createAgent({ brain, senseGroup: "confirm_senses" });
      let n = 0;
      const chunks = await runSendWithApproval(agent, "写两个", () => {
        n++;
        return n === 1 ? "accept" : { action: "reject", reason: "第二个不要" };
      });
      expect(senseAccepts(chunks)).toHaveLength(1);
      expect(senseRejects(chunks)).toHaveLength(1);
      expect(senseRejects(chunks)[0]?.reason).toContain("第二个不要");
    } finally {
      cleanupTempDir(dir);
    }
  });

  it("2 confirm call：A accept 执行后 B 断连 abort → throw AgentAbortError + A 的 sense_accept 已 yield", async () => {
    const dir = createTempDir();
    const brain = addMockBrain("seq-abort", {
      repeat: "last",
      script: [
        scriptItem({
          content: "两个写",
          senseCalls: [
            { id: "sa-0", name: "write_file", arguments: JSON.stringify({ path: `${dir}/a.txt`, content: "a" }) },
            { id: "sa-1", name: "write_file", arguments: JSON.stringify({ path: `${dir}/b.txt`, content: "b" }) },
          ],
        }),
        scriptItem({ content: "done" }),
      ],
    });
    try {
      const agent = createAgent({ brain, senseGroup: "confirm_senses" });
      const out: MiddlewareChunk[] = [];
      let n = 0;
      let thrown: unknown;
      try {
        for await (const c of agent.run("写两个")) {
          out.push(c);
          if (c.type === "sense_pending") {
            const pending = c as SensePendingChunk;
            n++;
            // A：accept；B：断连 abort。executeCollectedCalls 预挂 no-op catch，
            // 故 B 在 await 前 reject 不触发 unhandled rejection，await 仍 throw。
            if (n === 1) approve(pending.approvalId, "accept");
            else abortApproval(pending.approvalId);
          }
        }
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(AgentAbortError);
      // sequential：A 在 B abort 前已执行并 yield sense_accept（旧 Promise.all 屏障下 A 不会执行）
      expect(senseAccepts(out)).toHaveLength(1);
      expect(senseAccepts(out)[0]?.id).toBe("sa-0");
    } finally {
      cleanupTempDir(dir);
    }
  });
});
