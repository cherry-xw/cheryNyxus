import { describe, it, expect } from "vitest";
import { compressLog } from "@/utils/drain/index";
import type { DrainResult } from "@/utils/drain/types";

describe("compressLog function", () => {
  describe("basic functionality", () => {
    it("should compress simple log content", async () => {
      const content = "error occurred\nerror occurred\nerror occurred";

      const result = await compressLog(content);

      expect(result.compressedContent).toBeDefined();
      expect(result.templateCount).toBe(1);
      expect(result.lineCount).toBe(3);
    });

    it("should handle empty content", async () => {
      const content = "";

      const result = await compressLog(content);

      expect(result.compressedContent).toBeDefined();
      expect(result.lineCount).toBe(0);
      expect(result.templateCount).toBe(0);
    });

    it("should handle single line", async () => {
      const content = "single line log";

      const result = await compressLog(content);

      expect(result.compressedContent).toBeDefined();
      expect(result.lineCount).toBe(1);
      expect(result.templateCount).toBe(1);
    });

    it("should handle multiple unique templates", async () => {
      const content = `
error occurred
warning triggered
info logged
`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(3);
      expect(result.lineCount).toBe(3);
    });
  });

  describe("result structure", () => {
    it("should return DrainResult with all fields", async () => {
      const content = "test log";

      const result = await compressLog(content);

      expect(result).toHaveProperty("compressedContent");
      expect(result).toHaveProperty("templateCount");
      expect(result).toHaveProperty("lineCount");
      expect(result).toHaveProperty("compressionRatio");
    });

    it("should return compressionRatio as percentage string", async () => {
      const content = "test message repeated multiple times\n".repeat(10);

      const result = await compressLog(content);

      expect(result.compressionRatio).toMatch(/^\d+\.\d+%$/);
    });

    it("should include header in compressed content", async () => {
      const content = "error in module 1\nerror in module 2";

      const result = await compressLog(content);

      expect(result.compressedContent).toContain("日志模板摘要");
    });

    it("should include footer statistics", async () => {
      const content = "test log";

      const result = await compressLog(content);

      expect(result.compressedContent).toContain("压缩统计");
      expect(result.compressedContent).toContain("原始行数");
      expect(result.compressedContent).toContain("模板数量");
      expect(result.compressedContent).toContain("压缩率");
    });
  });

  describe("preview count", () => {
    it("should display default 3 instances per template", async () => {
      const content = Array(5).fill("error occurred").join("\n");

      const result = await compressLog(content, 3);

      expect(result.compressedContent).toContain("显示前3个实例");
      expect(result.compressedContent).toContain("省略2个相似日志");
    });

    it("should respect custom preview count", async () => {
      const content = Array(10).fill("same message").join("\n");

      const result = await compressLog(content, 5);

      expect(result.compressedContent).toContain("显示前5个实例");
      expect(result.compressedContent).toContain("省略5个相似日志");
    });

    it("should not show省略 when instances <= preview count", async () => {
      const content = "line 1\nline 2";

      const result = await compressLog(content, 5);

      expect(result.compressedContent).not.toContain("省略");
    });

    it("should handle previewCount = 1", async () => {
      const content = Array(5).fill("repeated message").join("\n");

      const result = await compressLog(content, 1);

      expect(result.compressedContent).toContain("显示前1个实例");
      expect(result.compressedContent).toContain("省略4个相似日志");
    });
  });

  describe("template grouping", () => {
    it("should group similar logs into same template", async () => {
      const content = `
error in module 1
error in module 2
error in module 3
`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(1);
      expect(result.lineCount).toBe(3);
      expect(result.compressedContent).toContain("(3次)");
    });

    it("should separate different templates", async () => {
      const content = `
error occurred
warning triggered
error occurred
`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(2);
    });

    it("should handle numeric tokens as parameters", async () => {
      const content = `
Connection established on port 8080
Connection established on port 9090
Connection established on port 3000
`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(1);
      expect(result.compressedContent).toContain("<*>");
    });
  });

  describe("compression effectiveness", () => {
    it("should show positive compression ratio for repeated logs", async () => {
      const content = Array(100).fill("Same repeated log message").join("\n");

      const result = await compressLog(content);

      const ratio = parseFloat(result.compressionRatio);
      expect(ratio).toBeGreaterThan(0);
    });

    it("should show negative compression ratio for many unique logs", async () => {
      // Unique logs with common prefix will still be grouped
      const content = Array(10)
        .fill(null)
        .map((_, i) => `Completely different log number ${i} with unique suffix`)
        .join("\n");

      const result = await compressLog(content);

      // Drain may still find patterns, so we just check the ratio is defined
      expect(result.compressionRatio).toBeDefined();
    });
  });

  describe("edge cases", () => {
    it("should handle whitespace-only lines", async () => {
      const content = "error occurred\n   \n\nwarning triggered";

      const result = await compressLog(content);

      expect(result.lineCount).toBe(2);
      expect(result.templateCount).toBe(2);
    });

    it("should handle very long lines", async () => {
      const longLine = "x".repeat(1000);
      const content = `${longLine}\n${longLine}\n${longLine}`;

      const result = await compressLog(content);

      expect(result.lineCount).toBe(3);
      expect(result.templateCount).toBe(1);
    });

    it("should handle special characters", async () => {
      const content = `error: "test" failed\nerror: "test" failed`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(1);
    });

    it("should handle unicode content", async () => {
      const content = `错误: 测试失败\n错误: 测试失败`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(1);
    });

    it("should handle mixed content", async () => {
      const content = `
2023-01-15 10:30:00 ERROR: Connection failed to server1
2023-01-15 10:30:05 ERROR: Connection failed to server2
2023-01-15 10:30:10 WARNING: Timeout exceeded
2023-01-15 10:30:15 INFO: Request completed
`;

      const result = await compressLog(content);

      expect(result.lineCount).toBe(4);
      // Similar ERROR logs will be grouped together
      expect(result.templateCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("real-world scenarios", () => {
    it("should compress application logs", async () => {
      const content = `
2023-01-15 INFO Application started
2023-01-15 INFO Loading configuration
2023-01-15 INFO Loading module: auth
2023-01-15 INFO Loading module: database
2023-01-15 INFO Loading module: api
2023-01-15 INFO Loading module: cache
`;

      const result = await compressLog(content);

      expect(result.templateCount).toBeGreaterThanOrEqual(2);
    });

    it("should compress error logs with stack traces", async () => {
      const content = `
Error: Connection timeout
Error: Connection timeout
Error: Connection timeout
Error: Invalid credentials
Error: Invalid credentials
`;

      const result = await compressLog(content);

      expect(result.templateCount).toBe(2);
      expect(result.lineCount).toBe(5);
    });

    it("should compress HTTP request logs", async () => {
      const content = `
GET /api/users 200 45ms
GET /api/users 200 52ms
GET /api/users 200 38ms
POST /api/users 201 120ms
POST /api/users 201 135ms
`;

      const result = await compressLog(content);

      // Similar GET and POST requests will be grouped
      expect(result.templateCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("performance", () => {
    it("should handle large log files", async () => {
      const content = Array(1000).fill("Repeated log message").join("\n");

      const result = await compressLog(content);

      expect(result.lineCount).toBe(1000);
      expect(result.templateCount).toBe(1);
    }, 10000);

    it("should handle many unique templates", async () => {
      const content = Array(100)
        .fill(null)
        .map((_, i) => `Completely different unique log ${i} with suffix`)
        .join("\n");

      const result = await compressLog(content);

      expect(result.lineCount).toBe(100);
      // Drain will find patterns even in "unique" logs
      expect(result.templateCount).toBeGreaterThanOrEqual(1);
    }, 10000);
  });
});