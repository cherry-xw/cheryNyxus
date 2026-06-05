import { describe, it, expect, vi, beforeEach } from "vitest";
import writeTool from "@/agent/tool/write";
import { SupervisionLevel } from "@/core/config";
import type { ToolSharedData } from "@/core/tool";
import { writeFile, rename, copyFile, unlink, stat } from "fs/promises";

vi.mock("@/utils/config", () => ({
  default: {},
}));

vi.mock("@/utils/hash", () => ({
  hashGenerator: vi.fn(() => "test-hash"),
}));

vi.mock("fs/promises", () => ({
  writeFile: vi.fn(),
  rename: vi.fn(),
  copyFile: vi.fn(),
  unlink: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("os", () => ({
  default: { tmpdir: () => "/tmp" },
}));

describe("Write Tool", () => {
  describe("tool definition", () => {
    it("should have correct name", () => {
      expect(writeTool.definition.function.name).toBe("write_file");
    });

    it("should have correct supervision level", () => {
      expect(writeTool.supervisionLevel).toBe(SupervisionLevel.manual);
    });

    it("should have valid schema", () => {
      expect(writeTool.definition.function.parameters).toBeDefined();
    });

    it("should have description", () => {
      expect(writeTool.definition.function.description).toBeDefined();
    });
  });

  describe("executor", () => {
    let sharedData: ToolSharedData;

    beforeEach(() => {
      vi.clearAllMocks();
      sharedData = new Map();
    });

    it("should write file successfully via temp + rename", async () => {
      const result = await writeTool.executor.execute(
        { path: "/abs/new.txt", content: "hello" },
        sharedData,
      );

      expect(result.content).toContain("成功写入文件");
      expect(result.hash).toBe("");
      expect(vi.mocked(writeFile)).toHaveBeenCalled();
      expect(vi.mocked(rename)).toHaveBeenCalled();
    });

    it("should detect file modification conflict", async () => {
      const readNamespace = new Map();
      readNamespace.set("/abs/file.txt", { size: 100, mtimeMs: 1000, baseHash: "old-hash" });
      sharedData.set("read_file", readNamespace);

      vi.mocked(stat).mockResolvedValue({ size: 200, mtimeMs: 2000 } as any);

      const result = await writeTool.executor.execute(
        { path: "/abs/file.txt", content: "new content" },
        sharedData,
      );

      expect(result.content).toContain("文件修改警告");
      expect(result.hash).toBe("");
    });

    it("should allow write when hash matches", async () => {
      const readNamespace = new Map();
      readNamespace.set("/abs/file.txt", { size: 100, mtimeMs: 1000, baseHash: "test-hash" });
      sharedData.set("read_file", readNamespace);

      vi.mocked(stat).mockResolvedValue({ size: 100, mtimeMs: 1000 } as any);

      const result = await writeTool.executor.execute(
        { path: "/abs/file.txt", content: "updated" },
        sharedData,
      );

      expect(result.content).toContain("成功写入文件");
    });

    it("should skip conflict check when file was deleted (ENOENT)", async () => {
      const readNamespace = new Map();
      readNamespace.set("/abs/deleted.txt", { size: 100, mtimeMs: 1000, baseHash: "test-hash" });
      sharedData.set("read_file", readNamespace);

      vi.mocked(stat).mockRejectedValue(Object.assign(new Error("not found"), { code: "ENOENT" }));

      const result = await writeTool.executor.execute(
        { path: "/abs/deleted.txt", content: "rewrite" },
        sharedData,
      );

      expect(result.content).toContain("成功写入文件");
    });

    it("should handle stat error other than ENOENT", async () => {
      const readNamespace = new Map();
      readNamespace.set("/abs/file.txt", { size: 100, mtimeMs: 1000, baseHash: "test-hash" });
      sharedData.set("read_file", readNamespace);

      vi.mocked(stat).mockRejectedValue(Object.assign(new Error("access denied"), { code: "EACCES" }));
      vi.mocked(writeFile).mockRejectedValue(Object.assign(new Error("access denied"), { code: "EACCES" }));

      const result = await writeTool.executor.execute(
        { path: "/abs/file.txt", content: "test" },
        sharedData,
      );

      expect(result.content).toContain("权限不足");
    });

    it("should fallback to copy+delete on EXDEV error", async () => {
      vi.mocked(writeFile).mockReset();
      vi.mocked(stat).mockReset();
      vi.mocked(rename).mockImplementation(async () => {
        throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      });
      vi.mocked(copyFile).mockResolvedValue(undefined);
      vi.mocked(unlink).mockResolvedValue(undefined);

      const result = await writeTool.executor.execute(
        { path: "/abs/file.txt", content: "test" },
        sharedData,
      );

      expect(result.content).toContain("跨文件系统移动");
      expect(vi.mocked(copyFile)).toHaveBeenCalled();
      expect(vi.mocked(unlink)).toHaveBeenCalled();
    });

    it("should handle ENOENT directory missing error", async () => {
      vi.mocked(writeFile).mockRejectedValue(
        Object.assign(new Error("no dir"), { code: "ENOENT" }),
      );

      const result = await writeTool.executor.execute(
        { path: "/abs/nonexistent/file.txt", content: "test" },
        sharedData,
      );

      expect(result.content).toContain("目录不存在");
    });

    it("should handle EACCES permission error", async () => {
      vi.mocked(writeFile).mockRejectedValue(
        Object.assign(new Error("no access"), { code: "EACCES" }),
      );

      const result = await writeTool.executor.execute(
        { path: "/abs/protected.txt", content: "test" },
        sharedData,
      );

      expect(result.content).toContain("权限不足");
    });

    it("should handle generic write error", async () => {
      vi.mocked(writeFile).mockRejectedValue(new Error("unknown error"));

      const result = await writeTool.executor.execute(
        { path: "/abs/file.txt", content: "test" },
        sharedData,
      );

      expect(result.content).toContain("失败");
    });
  });
});
