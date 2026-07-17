import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanupTempDir, createTempDir } from "../../helpers/tempDir.js";

describe("system commands", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = createTempDir();
    previous = process.env.CHERY_DIR;
    process.env.CHERY_DIR = dir;
    mkdirSync(join(dir, ".chery", "command"), { recursive: true });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CHERY_DIR;
    else process.env.CHERY_DIR = previous;
    cleanupTempDir(dir);
  });

  it("reads editable compact metadata and body at call time", async () => {
    writeFileSync(join(dir, ".chery", "command", "compact.md"), "---\nname: compact\ndescription: short\n---\nsummary body");
    const { getSystemCommand } = await import("@/agent/prompt/loadCommand.js");
    expect(getSystemCommand("compact")).toEqual({ name: "compact", description: "short", content: "summary body" });
  });
});
