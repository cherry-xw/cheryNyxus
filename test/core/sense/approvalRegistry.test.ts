/**
 * approvalRegistry 单元测试（P1.9：审批超时机制）。
 *
 * 决策2 语义：
 * - 超时 → AgentParkError，保留 pending sense，不冒充用户拒绝
 * - 断连 → rejectApproval(AgentAbortError) → throw → resume Case1
 * - resolve/reject 前若已超时，timer 须清除避免泄漏/重复触发
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createApproval, resolveApproval, rejectApproval, clearAllApprovals } from "@/core/sense/index.js";
import { AgentAbortError, AgentParkError } from "@/core/middleware/errors.js";

describe("approvalRegistry 超时（P1.9）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("超时 → park，保留为可恢复交互", async () => {
    const p = createApproval("t-timeout", 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toBeInstanceOf(AgentParkError);
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

  it("timeoutMs <= 0 → 不限时（同 undefined）", async () => {
    const p = createApproval("t-zero", 0);
    vi.advanceTimersByTime(60000);
    // 仍 pending → 手动结束
    resolveApproval("t-zero", "accept");
    expect((await p).action).toBe("accept");
  });

  it("resolveApproval 对不存在的 id 无副作用（不抛错）", () => {
    expect(() => resolveApproval("nonexistent", "accept")).not.toThrow();
  });

  it("rejectApproval 对不存在的 id 无副作用（不抛错）", () => {
    expect(() => rejectApproval("nonexistent", new Error("x"))).not.toThrow();
  });

  it("resolveApproval 带 reason 传递到 decision", async () => {
    const p = createApproval("t-reason", 5000);
    resolveApproval("t-reason", "reject", "用户拒绝");
    const decision = await p;
    expect(decision.action).toBe("reject");
    expect(decision.reason).toBe("用户拒绝");
  });

  it("超时后 resolve/reject 不再触发（registry 已删）", async () => {
    const p = createApproval("t-post-timeout", 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toBeInstanceOf(AgentParkError);
    // 再次 resolve 同 id → 无副作用
    resolveApproval("t-post-timeout", "accept");
    // Promise 已 settled，不会改变
    await expect(p).rejects.toBeInstanceOf(AgentParkError);
  });
});

describe("approvalRegistry hard-timeout（G2：不限时审批资源上限）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("timeoutMs<=0 + hardTimeoutMs → 到点 reject(AgentParkError) 归 paused（非用户拒绝）", async () => {
    const p = createApproval("h-park", 0, 1000);
    vi.advanceTimersByTime(1000);
    await expect(p).rejects.toBeInstanceOf(AgentParkError);
  });

  it("hardTimeoutMs 仅当 timeoutMs<=0 生效（用户窗口优先，不叠加）", async () => {
    const p = createApproval("h-user", 500, 100000);
    vi.advanceTimersByTime(500);
    await expect(p).rejects.toBeInstanceOf(AgentParkError);
  });

  it("hard-timeout 前用户 accept → resolve accept，hard timer 清除", async () => {
    const p = createApproval("h-accept", 0, 1000);
    resolveApproval("h-accept", "accept");
    const decision = await p;
    expect(decision.action).toBe("accept");
    vi.advanceTimersByTime(2000); // hard timer 已 clear，无延迟 reject
    expect(await p).toEqual(decision);
  });

  it("hard-timeout 前 park（reject AgentParkError）→ hard timer 清除", async () => {
    const p = createApproval("h-park-early", 0, 1000);
    rejectApproval("h-park-early", new AgentParkError());
    await expect(p).rejects.toBeInstanceOf(AgentParkError);
    vi.advanceTimersByTime(2000);
  });

  it("无 hardTimeoutMs（undefined）→ 不限时（向后兼容）", async () => {
    const p = createApproval("h-none", 0);
    vi.advanceTimersByTime(60000);
    resolveApproval("h-none", "accept");
    expect((await p).action).toBe("accept");
  });
});

describe("clearAllApprovals", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects all pending approvals with abort error", async () => {
    const p1 = createApproval("c1", 10000);
    const p2 = createApproval("c2", 10000);
    const p3 = createApproval("c3"); // no timeout

    clearAllApprovals();

    await expect(p1).rejects.toThrow("审批被中止");
    await expect(p2).rejects.toThrow("审批被中止");
    await expect(p3).rejects.toThrow("审批被中止");
  });

  it("clears timeout timers to prevent leaks", async () => {
    const p = createApproval("c-timer", 1000);
    clearAllApprovals();
    // Advance past timeout — timer already cleared, no double-reject
    vi.advanceTimersByTime(2000);
    await expect(p).rejects.toThrow("审批被中止");
  });

  it("no-op when registry is empty", () => {
    expect(() => clearAllApprovals()).not.toThrow();
  });
});
