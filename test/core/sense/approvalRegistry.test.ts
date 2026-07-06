/**
 * approvalRegistry 单元测试（P1.9：审批超时机制）。
 *
 * 决策2 语义：
 * - 超时 → resolve as reject（非 abort）→ sense_reject → resume Case2
 * - 断连 → rejectApproval(AgentAbortError) → throw → resume Case1
 * - resolve/reject 前若已超时，timer 须清除避免泄漏/重复触发
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApproval, resolveApproval, rejectApproval } from "@/core/sense/index.js";
import { AgentAbortError } from "@/core/middleware/errors.js";

describe("approvalRegistry 超时（P1.9）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("超时 → resolve as reject（reason 含「超时」，非 abort reject）", async () => {
    const p = createApproval("t-timeout", 1000);
    vi.advanceTimersByTime(1000);
    const decision = await p;
    expect(decision.action).toBe("reject");
    expect(decision.reason).toContain("超时");
  });

  it("超时前用户 accept → resolve accept，timer 清除（推进超时无副作用）", async () => {
    const p = createApproval("t-accept", 1000);
    resolveApproval("t-accept", "accept");
    const decision = await p;
    expect(decision.action).toBe("accept");
    // 推进超过超时时间：timer 已 clear，registry 已删，无延迟 reject
    vi.advanceTimersByTime(2000);
    expect(await p).toEqual(decision);
  });

  it("超时前断连 abort → reject AgentAbortError，timer 清除", async () => {
    const p = createApproval("t-abort", 1000);
    const err = new AgentAbortError();
    rejectApproval("t-abort", err);
    await expect(p).rejects.toBe(err);
    // 推进超时：timer 已 clear 不再 fire
    vi.advanceTimersByTime(2000);
  });

  it("无 timeoutMs → 不限时，仅手动 resolve/reject 结束", async () => {
    const p = createApproval("t-nolimit");
    vi.advanceTimersByTime(60000);
    // 仍 pending（未自动 resolve）→ 手动结束避免挂起测试
    resolveApproval("t-nolimit", "accept");
    expect((await p).action).toBe("accept");
  });
});
