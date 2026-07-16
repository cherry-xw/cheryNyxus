import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureRestartCoordinator,
  notifyRestartActivityChanged,
  requestRestartWhenIdle,
  resetRestartCoordinator,
} from "@/service/restartCoordinator.js";

describe("restartCoordinator", () => {
  afterEach(() => resetRestartCoordinator());

  it("without a supervisor, reports that a manual restart is required", () => {
    configureRestartCoordinator({ isIdle: () => true });
    expect(requestRestartWhenIdle()).toBe("manual");
  });

  it("reports immediate and notifies the supervisor once after the save response turn when idle", async () => {
    const onRestartReady = vi.fn();
    configureRestartCoordinator({ isIdle: () => true, onRestartReady });
    expect(requestRestartWhenIdle()).toBe("immediate");
    expect(onRestartReady).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onRestartReady).toHaveBeenCalledTimes(1);
  });

  it("waits for a busy chat to become idle", async () => {
    let idle = false;
    const onRestartReady = vi.fn();
    configureRestartCoordinator({ isIdle: () => idle, onRestartReady });
    expect(requestRestartWhenIdle()).toBe("scheduled");
    await new Promise((resolve) => setImmediate(resolve));
    expect(onRestartReady).not.toHaveBeenCalled();

    idle = true;
    notifyRestartActivityChanged();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onRestartReady).toHaveBeenCalledTimes(1);
  });

  it("coalesces repeated config saves into one restart", async () => {
    const onRestartReady = vi.fn();
    configureRestartCoordinator({ isIdle: () => true, onRestartReady });
    requestRestartWhenIdle();
    requestRestartWhenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onRestartReady).toHaveBeenCalledTimes(1);
  });
});
