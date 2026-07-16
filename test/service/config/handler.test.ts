import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/config.js", () => ({
  readRawConfig: vi.fn(),
  saveRawConfig: vi.fn(),
}));
vi.mock("@/service/restartCoordinator.js", () => ({ requestRestartWhenIdle: vi.fn() }));
vi.mock("@/utils/logger/index.js", () => ({ logger: { event: vi.fn() } }));

import { handleConfigSave } from "@/service/config/handler.js";
import { saveRawConfig } from "@/utils/config.js";
import { requestRestartWhenIdle } from "@/service/restartCoordinator.js";

describe("config.save restart scheduling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns scheduled after persisting valid configuration", async () => {
    vi.mocked(saveRawConfig).mockReturnValue({ ok: true });
    vi.mocked(requestRestartWhenIdle).mockReturnValue("scheduled");
    const result = await handleConfigSave({ requestId: "r", connectionId: "c", log: {} as never }, {} as never);
    expect(result).toEqual({ needRestart: true, restart: "scheduled" });
  });

  it("does not schedule a restart when validation fails", async () => {
    vi.mocked(saveRawConfig).mockReturnValue({ ok: false, errors: ["bad config"] });
    const result = await handleConfigSave({ requestId: "r", connectionId: "c", log: {} as never }, {} as never);
    expect(requestRestartWhenIdle).not.toHaveBeenCalled();
    expect((result as { success: boolean }).success).toBe(false);
  });
});
