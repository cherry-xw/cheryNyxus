import { describe, it, expect, beforeEach, vi } from "vitest";

// ApprovalManager 仅转调 core approvalRegistry，mock 掉以断言转发行为。
const mocks = vi.hoisted(() => ({
  resolveApproval: vi.fn(),
  rejectApproval: vi.fn(),
}));

vi.mock("@/core/sense/approvalRegistry.js", () => ({
  resolveApproval: mocks.resolveApproval,
  rejectApproval: mocks.rejectApproval,
}));

import { ApprovalManager } from "@/service/approval/manager.js";

describe("service/approval/ApprovalManager", () => {
  let manager: ApprovalManager;

  beforeEach(() => {
    manager = new ApprovalManager();
    mocks.resolveApproval.mockClear();
    mocks.rejectApproval.mockClear();
  });

  it("confirm forwards accept to core resolveApproval after register", () => {
    manager.register("a1");
    manager.confirm("a1", "accept");
    expect(mocks.resolveApproval).toHaveBeenCalledWith("a1", "accept", undefined);
  });

  it("confirm forwards reject with reason", () => {
    manager.register("a1");
    manager.confirm("a1", "reject", "user denied");
    expect(mocks.resolveApproval).toHaveBeenCalledWith("a1", "reject", "user denied");
  });

  it("confirm consumes id: second confirm is a no-op", () => {
    manager.register("a1");
    manager.confirm("a1", "accept");
    manager.confirm("a1", "accept");
    expect(mocks.resolveApproval).toHaveBeenCalledTimes(1);
  });

  it("confirm on unregistered id does nothing", () => {
    manager.confirm("unknown", "accept");
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("abort forwards to core rejectApproval with an Error", () => {
    manager.register("a1");
    manager.abort("a1");
    expect(mocks.rejectApproval).toHaveBeenCalledTimes(1);
    expect(mocks.rejectApproval.mock.calls[0]?.[0]).toBe("a1");
    expect(mocks.rejectApproval.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("abort on unregistered id does nothing", () => {
    manager.abort("unknown");
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
  });

  it("abort consumes id so later confirm is a no-op", () => {
    manager.register("a1");
    manager.abort("a1");
    manager.confirm("a1", "accept");
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });
});
