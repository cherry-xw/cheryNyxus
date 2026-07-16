import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeChild extends EventEmitter {
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    return signal === "SIGTERM" || signal === "SIGKILL";
  });
}

const spawn = vi.fn();
vi.mock("node:child_process", () => ({ spawn }));

describe("guardian entry point", () => {
  const originalArgv = process.argv;
  let child: FakeChild;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.argv = ["node", "index.js"];
    child = new FakeChild();
    spawn.mockReturnValue(child);
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("keeps node dist/index.js as the guardian command and starts an IPC worker", async () => {
    await import("@/index.js");
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["--worker"]),
      expect.objectContaining({ stdio: ["ignore", "inherit", "inherit", "ipc"] }),
    );
  });

  it("gracefully replaces the worker when it reports restart readiness", async () => {
    await import("@/index.js");
    await Promise.resolve();
    child.emit("message", { type: "restart-ready" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
