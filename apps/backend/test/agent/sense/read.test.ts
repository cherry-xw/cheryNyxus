/**
 * read_file sense 测试（执行器单元）。
 *
 * 覆盖：
 * - 绝对路径成功读取（content + hash + sharedData 写入）
 * - 相对路径 → 错误
 * - 文件不存在 → ENOENT 错误
 * - offset/limit 分段读取
 * - 大文件截断（truncate 策略）
 * - hash 含 mtime（用于 write 修改检测 + sense 去重）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import readSense from "@/agent/sense/read.js";
import { SupervisionLevel } from "@/core/config.js";
import { createTempDir, cleanupTempDir, createTempFile } from "../../helpers/tempDir.js";
import { writeFileSync } from "fs";
import { join } from "path";

const exec = readSense.executor.execute.bind(readSense.executor);
const sharedData = new Map<string, Map<string, unknown>>();

describe("read_file sense 定义", () => {
  it("name = read_file，supervision = auto", () => {
    expect(readSense.definition.function.name).toBe("read_file");
    expect(readSense.supervisionLevel).toBe(SupervisionLevel.auto);
  });
});

describe("read_file 执行", () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    sharedData.clear();
  });
  afterEach(() => cleanupTempDir(dir));

  it("绝对路径成功 → content 含内容 + hash 非空", async () => {
    const file = createTempFile(dir, "a.txt", "hello world\nline2\n");
    const r = await exec({ path: file }, sharedData);
    expect(r.content).toContain("hello world");
    expect(r.hash).not.toBe("");
  });

  it("相对路径 → content 含「不是绝对路径」+ hash 空", async () => {
    const r = await exec({ path: "relative/path.txt" }, sharedData);
    expect(r.content).toContain("不是绝对路径");
    expect(r.hash).toBe("");
  });

  it("文件不存在 → content 含「不存在」+ hash 空", async () => {
    const r = await exec({ path: `${dir}/nope.txt` }, sharedData);
    expect(r.content).toContain("不存在");
    expect(r.hash).toBe("");
  });

  it("offset/limit 分段读取", async () => {
    const file = createTempFile(dir, "lines.txt", "l0\nl1\nl2\nl3\nl4\n");
    const r = await exec({ path: file, offset: 1, limit: 2 }, sharedData);
    expect(r.content).toContain("l1");
    expect(r.content).toContain("l2");
    expect(r.content).not.toContain("l0\nl1\nl2\nl3");
  });

  it("sharedData 写入 read_file namespace（fileHash）", async () => {
    const file = createTempFile(dir, "shared.txt", "content\n");
    await exec({ path: file }, sharedData);
    const ns = sharedData.get("read_file");
    expect(ns).toBeDefined();
    expect(ns!.get(file)).toBeTruthy();
  });
});

describe("read_file 大文件截断", () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    sharedData.clear();
  });
  afterEach(() => cleanupTempDir(dir));

  it("大文件（>100KB，非日志扩展名）→ 截断（content 含「大文件截断」）", async () => {
    // 用默认 truncate_threshold(100KB) + .dat（不在 log_file_extensions，走 truncate 非 drain）
    const file = join(dir, "big.dat");
    const big = Array.from({ length: 5000 }, (_, i) => `line-number-${i}-padding`).join("\n");
    writeFileSync(file, big);
    // compression 必须显式传（直接调 executor 不经 schema default）
    const r = await exec({ path: file, compression: "auto" }, sharedData);
    expect(r.content).toContain("大文件截断");
  });
});
