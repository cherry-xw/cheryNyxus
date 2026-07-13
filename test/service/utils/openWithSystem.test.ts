import { describe, expect, it } from "vitest";
import { resolveSystemOpenCommand } from "@/service/utils/openWithSystem.js";

describe("service/utils/openWithSystem", () => {
  it("resolves the Windows shell command", () => {
    expect(resolveSystemOpenCommand("C:\\app\\.chery", "win32")).toEqual({
      command: "cmd",
      args: ["/d", "/s", "/c", "start", "", "C:\\app\\.chery"],
    });
  });

  it("resolves the macOS shell command", () => {
    expect(resolveSystemOpenCommand("/app/.chery", "darwin")).toEqual({
      command: "open",
      args: ["/app/.chery"],
    });
  });

  it("resolves the Linux shell command", () => {
    expect(resolveSystemOpenCommand("/app/.chery", "linux")).toEqual({
      command: "xdg-open",
      args: ["/app/.chery"],
    });
  });
});
