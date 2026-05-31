import { describe, it, expect, vi } from "vitest";
import readTool from "@/agent/tool/read";
import { SupervisionLevel } from "@/core/config";

// Mock config - 使用正确的路径格式
vi.mock("@/utils/config", () => ({
  default: {
    global: {
      file_compression: {
        truncate_threshold: 100,
        truncate_preview_lines: 50,
        log_file_extensions: [".log", ".txt"],
        drain_preview_count: 3,
      },
    },
  },
}));

// Mock env
vi.mock("@/utils/env", () => ({
  getWorkDir: vi.fn(() => process.cwd()),
}));

// Mock hash generator
vi.mock("@/utils/hash", () => ({
  hashGenerator: vi.fn(() => "test-hash"),
}));

// Mock drain compression
vi.mock("@/utils/drain", () => ({
  compressLog: vi.fn(async () => ({
    compressedContent: "compressed log",
    templateCount: 5,
    compressionRatio: "80%",
  })),
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
});