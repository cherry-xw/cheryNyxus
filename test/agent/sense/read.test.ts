import { describe, it, expect, vi, beforeEach } from "vitest";
import readTool from "@/agent/sense/read";
import { SupervisionLevel } from "@/core/config";
import type { ToolSharedData } from "@/core/sense";
import { stat, readFile } from "fs/promises";

vi.mock("@/utils/config", () => ({
  default: {
    global: {
      file_compression: {
        truncate_threshold: 100,
        truncate_preview_lines: 5,
        log_file_extensions: [".log", ".txt"],
        drain_preview_count: 3,
      },
    },
  },
}));

vi.mock("@/utils/hash", () => ({
  hashGenerator: vi.fn(() => "test-hash"),
}));

vi.mock("@/utils/drain", () => ({
  compressLog: vi.fn(async () => ({
    compressedContent: "compressed log",
    templateCount: 5,
    compressionRatio: "80%",
  })),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

describe("Read Tool", () => {
  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(readTool.definition.function.name).toBe("read_file");
    });

    it("should have correct supervision level", () => {
      expect(readTool.supervisionLevel).toBe(SupervisionLevel.auto);
    });

    it("should have valid schema", () => {
      expect(readTool.definition.function.parameters).toBeDefined();
    });

    it("should have description", () => {
      expect(readTool.definition.function.description).toBeDefined();
    });
  });

  describe("executor", () => {
    let sharedData: ToolSharedData;

    beforeEach(() => {
      vi.clearAllMocks();
      sharedData = new Map();
    });

    it("should reject relative path", async () => {
      const result = await readTool.executor.execute(
        { path: "relative/path.txt", compression: "none" },
        sharedData,
      );

      expect(result.content).toContain("不是绝对路径");
      expect(result.hash).toBe("");
    });

    it("should read small file successfully", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 50, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("line1\nline2\nline3");

      const result = await readTool.executor.execute(
        { path: "/abs/file.txt", compression: "auto" },
        sharedData,
      );

      expect(result.content).toContain("line1");
      expect(result.content).toContain("line2");
      expect(result.content).toContain("line3");
      expect(result.hash).toBe("test-hash");
    });

    it("should read file with none compression", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 200, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("big content here");

      const result = await readTool.executor.execute(
        { path: "/abs/big.txt", compression: "none" },
        sharedData,
      );

      expect(result.content).toContain("big content here");
    });

    it("should truncate large non-log file with auto compression", async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      vi.mocked(stat).mockResolvedValue({ size: 200, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue(lines.join("\n"));

      const result = await readTool.executor.execute(
        { path: "/abs/big.ts", compression: "auto" },
        sharedData,
      );

      expect(result.content).toContain("大文件截断");
      expect(result.content).toContain("省略了剩余");
    });

    it("should use drain compression for large log file with auto", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 200, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("log line 1\nlog line 2");

      const result = await readTool.executor.execute(
        { path: "/abs/app.log", compression: "auto" },
        sharedData,
      );

      expect(result.content).toContain("Drain去重");
    });

    it("should use drain compression when explicitly set", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 50, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("log content");

      const result = await readTool.executor.execute(
        { path: "/abs/file.log", compression: "drain" },
        sharedData,
      );

      expect(result.content).toContain("Drain去重");
    });

    it("should fallback to truncate when drain fails on large file", async () => {
      const { compressLog } = vi.mocked(await import("@/utils/drain"));
      compressLog.mockRejectedValueOnce(new Error("drain failed"));

      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      vi.mocked(stat).mockResolvedValue({ size: 200, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue(lines.join("\n"));

      const result = await readTool.executor.execute(
        { path: "/abs/app.log", compression: "drain" },
        sharedData,
      );

      expect(result.content).toContain("截断（Drain失败回退）");
    });

    it("should handle offset and limit", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 50, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("line1\nline2\nline3\nline4\nline5");

      const result = await readTool.executor.execute(
        { path: "/abs/file.txt", compression: "none", offset: 1, limit: 2 },
        sharedData,
      );

      expect(result.content).toContain("line2");
      expect(result.content).toContain("line3");
      expect(result.content).not.toContain("line1");
      expect(result.content).not.toContain("line4");
    });

    it("should return empty range message when offset exceeds lines", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 50, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("line1\nline2");

      const result = await readTool.executor.execute(
        { path: "/abs/file.txt", compression: "none", offset: 10, limit: 5 },
        sharedData,
      );

      expect(result.content).toContain("没有内容");
      expect(result.hash).toBe("");
    });

    it("should handle ENOENT error", async () => {
      vi.mocked(stat).mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));

      const result = await readTool.executor.execute(
        { path: "/abs/missing.txt", compression: "none" },
        sharedData,
      );

      expect(result.content).toContain("不存在");
      expect(result.hash).toBe("");
    });

    it("should handle generic read error", async () => {
      vi.mocked(stat).mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

      const result = await readTool.executor.execute(
        { path: "/abs/protected.txt", compression: "none" },
        sharedData,
      );

      expect(result.content).toContain("失败");
      expect(result.hash).toBe("");
    });

    it("should populate senseSharedData with read_file namespace", async () => {
      vi.mocked(stat).mockResolvedValue({ size: 50, mtimeMs: 1000 } as any);
      vi.mocked(readFile).mockResolvedValue("content");

      await readTool.executor.execute(
        { path: "/abs/file.txt", compression: "none" },
        sharedData,
      );

      const readNamespace = sharedData.get("read_file");
      expect(readNamespace).toBeDefined();
      expect(readNamespace!.get("/abs/file.txt")).toBe("test-hash");
    });
  });
});
