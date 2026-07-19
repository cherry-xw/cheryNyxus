/**
 * spawnBroker 单元测试：broadcaster + wait 唤醒链 + 看门狗。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setSpawnBroadcaster,
  emitRoleCreated,
  emitRoleDestroyed,
  setAsyncWakeHandler,
  registerWaitedChild,
  getWaitedParent,
  clearWaitedChild,
  clearWaitedChildrenByParent,
  clearAllWaitedChildren,
  type RoleCreatedData,
  type RoleDestroyedData,
} from "@/agent/spawnBroker.js";

describe("spawnBroker broadcaster", () => {
  const broadcaster = vi.fn();

  beforeEach(() => {
    broadcaster.mockClear();
    setSpawnBroadcaster(broadcaster);
  });

  afterEach(() => {
    setSpawnBroadcaster(null as any);
  });

  it("emitRoleCreated → broadcaster('created')", () => {
    const data: RoleCreatedData = {
      taskId: "t1",
      chatId: "c1",
      parentChatId: "p1",
      type: "reviewer",
      avatar: "🦉",
      prompt: "review",
      brain: "mock",
      senseGroup: "auto",
      wait: true,
    };
    emitRoleCreated(data);
    expect(broadcaster).toHaveBeenCalledWith("p1", "created", data);
  });

  it("emitRoleDestroyed → broadcaster('destroyed')", () => {
    const data: RoleDestroyedData = { chatId: "c1" };
    emitRoleDestroyed("p1", data);
    expect(broadcaster).toHaveBeenCalledWith("p1", "destroyed", data);
  });

  it("broadcaster 未注入 → warn 不抛错", () => {
    setSpawnBroadcaster(null as any);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitRoleCreated({
      taskId: "t1",
      chatId: "c1",
      parentChatId: "p1",
      type: "x",
      avatar: "",
      prompt: "",
      brain: "",
      senseGroup: "",
      wait: false,
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("spawnBroker wait 唤醒链", () => {
  beforeEach(() => {
    clearAllWaitedChildren();
  });

  it("registerWaitedChild + getWaitedParent", () => {
    registerWaitedChild("c1", "p1", "reviewer");
    const entry = getWaitedParent("c1");
    expect(entry).toEqual({ parentChatId: "p1", type: "reviewer" });
  });

  it("重复注册 → throw", () => {
    registerWaitedChild("c1", "p1", "reviewer");
    expect(() => registerWaitedChild("c1", "p1", "reviewer")).toThrow("waitedChild 已存在");
  });

  it("clearWaitedChild → 清除记录", () => {
    registerWaitedChild("c1", "p1", "reviewer");
    clearWaitedChild("c1");
    expect(getWaitedParent("c1")).toBeUndefined();
  });

  it("clearWaitedChild 幂等", () => {
    clearWaitedChild("nonexistent"); // 不抛错
  });

  it("clearWaitedChildrenByParent → 清除该主的所有子", () => {
    registerWaitedChild("c1", "p1", "a");
    registerWaitedChild("c2", "p1", "b");
    registerWaitedChild("c3", "p2", "c");
    clearWaitedChildrenByParent("p1");
    expect(getWaitedParent("c1")).toBeUndefined();
    expect(getWaitedParent("c2")).toBeUndefined();
    expect(getWaitedParent("c3")).toBeDefined();
  });

  it("clearAllWaitedChildren → 清空全部", () => {
    registerWaitedChild("c1", "p1", "a");
    registerWaitedChild("c2", "p2", "b");
    clearAllWaitedChildren();
    expect(getWaitedParent("c1")).toBeUndefined();
    expect(getWaitedParent("c2")).toBeUndefined();
  });
});

describe("spawnBroker 看门狗", () => {
  beforeEach(() => {
    clearAllWaitedChildren();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAllWaitedChildren();
    vi.useRealTimers();
  });

  it("超时 → asyncWakeHandler 调用", () => {
    const handler = vi.fn();
    setAsyncWakeHandler(handler);
    registerWaitedChild("c1", "p1", "reviewer");
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(handler).toHaveBeenCalledWith({
      childChatId: "c1",
      parentChatId: "p1",
      type: "reviewer",
    });
  });

  it("正常清除 → 看门狗不触发", () => {
    const handler = vi.fn();
    setAsyncWakeHandler(handler);
    registerWaitedChild("c1", "p1", "reviewer");
    clearWaitedChild("c1");
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(handler).not.toHaveBeenCalled();
  });
});
