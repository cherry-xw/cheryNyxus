import { describe, it, expect, beforeEach, vi } from "vitest";

describe("env module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  describe("initEnvInfo", () => {
    it("should initialize envInfo with workDir", async () => {
      const testDir = "/test/work/dir";
      const { initEnvInfo, getEnvInfo } = await import("@/utils/env");

      initEnvInfo(testDir);

      const info = getEnvInfo();
      expect(info.workDir).toBe(testDir);
    });

    it("should populate os field", async () => {
      const { initEnvInfo, getEnvInfo } = await import("@/utils/env");
      initEnvInfo("/test");
      const info = getEnvInfo();
      expect(info.os).toBeTruthy();
      expect(typeof info.os).toBe("string");
    });

    it("should populate date field with YYYY-MM-DD format", async () => {
      const { initEnvInfo, getEnvInfo } = await import("@/utils/env");
      initEnvInfo("/test");
      const info = getEnvInfo();
      expect(info.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should populate time field with ISO format", async () => {
      const { initEnvInfo, getEnvInfo } = await import("@/utils/env");
      initEnvInfo("/test");
      const info = getEnvInfo();
      expect(info.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe("getWorkDir", () => {
    it("should throw error if not initialized", async () => {
      const { getWorkDir } = await import("@/utils/env");
      expect(() => getWorkDir()).toThrow("EnvInfo not initialized");
    });

    it("should return workDir after initialization", async () => {
      const testDir = "/my/work/dir";
      const { initEnvInfo, getWorkDir } = await import("@/utils/env");
      initEnvInfo(testDir);
      expect(getWorkDir()).toBe(testDir);
    });
  });

  describe("getOS", () => {
    it("should throw error if not initialized", async () => {
      const { getOS } = await import("@/utils/env");
      expect(() => getOS()).toThrow("EnvInfo not initialized");
    });

    it("should return os string after initialization", async () => {
      const { initEnvInfo, getOS } = await import("@/utils/env");
      initEnvInfo("/test");
      const os = getOS();
      expect(os).toBeTruthy();
      expect(typeof os).toBe("string");
    });
  });

  describe("getDate", () => {
    it("should return date in YYYY-MM-DD format without initialization", async () => {
      const { getDate } = await import("@/utils/env");
      const date = getDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("should return current date", async () => {
      const { getDate } = await import("@/utils/env");
      const date = getDate();
      const now = new Date();
      const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      expect(date).toBe(expected);
    });
  });

  describe("getTime", () => {
    it("should return time in ISO format without initialization", async () => {
      const { getTime } = await import("@/utils/env");
      const time = getTime();
      expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("should return current time in ISO format", async () => {
      const { getTime } = await import("@/utils/env");
      const time = getTime();
      const parsed = new Date(time);
      expect(parsed instanceof Date).toBe(true);
    });
  });

  describe("getEnvInfo", () => {
    it("should throw error if not initialized", async () => {
      const { getEnvInfo } = await import("@/utils/env");
      expect(() => getEnvInfo()).toThrow("EnvInfo not initialized");
    });

    it("should return complete envInfo object", async () => {
      const { initEnvInfo, getEnvInfo } = await import("@/utils/env");
      initEnvInfo("/test/dir");
      const info = getEnvInfo();

      expect(info).toHaveProperty("workDir");
      expect(info).toHaveProperty("os");
      expect(info).toHaveProperty("date");
      expect(info).toHaveProperty("time");
    });

    it("should return real-time updated time", async () => {
      const { initEnvInfo, getEnvInfo } = await import("@/utils/env");
      initEnvInfo("/test");

      const info1 = getEnvInfo();
      await new Promise(resolve => setTimeout(resolve, 10));
      const info2 = getEnvInfo();

      expect(info1.date).toBe(info2.date);
      expect(info1.time).not.toBe(info2.time);
    });
  });

  describe("resolvePath", () => {
    it("should return absolute path unchanged", async () => {
      const { initEnvInfo, resolvePath } = await import("@/utils/env");
      initEnvInfo("/base/work/dir");

      const absolutePath = "/absolute/path/to/file";
      expect(resolvePath(absolutePath)).toBe(absolutePath);
    });

    it("should resolve relative path to absolute", async () => {
      const { initEnvInfo, resolvePath } = await import("@/utils/env");
      initEnvInfo("/base/work/dir");

      const relativePath = "./relative/path";
      const resolved = resolvePath(relativePath);
      expect(resolved).toBe("/base/work/dir/relative/path");
    });

    it("should resolve parent directory references", async () => {
      const { initEnvInfo, resolvePath } = await import("@/utils/env");
      initEnvInfo("/base/work/dir");

      const relativePath = "../parent/dir";
      const resolved = resolvePath(relativePath);
      expect(resolved).toBe("/base/work/parent/dir");
    });

    it("should resolve simple relative path", async () => {
      const { initEnvInfo, resolvePath } = await import("@/utils/env");
      initEnvInfo("/base/work/dir");

      const relativePath = "simple/path";
      const resolved = resolvePath(relativePath);
      expect(resolved).toBe("/base/work/dir/simple/path");
    });

    it("should throw error if not initialized", async () => {
      const { resolvePath } = await import("@/utils/env");
      expect(() => resolvePath("test")).toThrow();
    });
  });
});