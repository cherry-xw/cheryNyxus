/**
 * write_file sense 测试（执行器单元）。
 *
 * 覆盖：
 * - 成功写入新文件（content + 文件落地）
 * - 覆盖已有文件
 * - offset+limit 行范围替换（需先 read 填 sharedData）
 * - 单独 offset/limit → 错误
 * - 行范围未 read → 错误
 * - 行范围文件不存在 → 错误
 * - 目录不存在 → ENOENT 错误
 * - 已存在文件被外部修改 → 警告
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import writeSense from "@/agent/sense/write.js";
import readSense from "@/agent/sense/read.js";
import { SupervisionLevel } from "@/core/config.js";
import { createTempDir, cleanupTempDir } from "../../helpers/tempDir.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const exec = writeSense.executor.execute.bind(writeSense.executor);
const sharedData = new Map<string, Map<string, unknown>>();

describe("write_file sense 定义", () => {
  it("name = write_file，supervision = manual", () => {
    expect(writeSense.definition.function.name).toBe("write_file");
    expect(writeSense.supervisionLevel).toBe(SupervisionLevel.manual);
  });
});

describe("write_file 完整写入", () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    sharedData.clear();
  });
  afterEach(() => cleanupTempDir(dir));

  it("成功写入新文件 → content「成功写入」+ 文件落地", async () => {
    const path = join(dir, "new.txt");
    const r = await exec({ path, content: "hello" }, sharedData);
    expect(r.content).toContain("成功写入");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("hello");
    expect(r.hash).toBe("");
  });

  it("覆盖已有文件", async () => {
    const path = join(dir, "exist.txt");
    writeFileSync(path, "old");
    await exec({ path, content: "new" }, sharedData);
    expect(readFileSync(path, "utf-8")).toBe("new");
  });
});

describe("write_file 行范围替换", () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    sharedData.clear();
  });
  afterEach(() => cleanupTempDir(dir));

  it("先 read 再 offset+limit 替换 → content「成功替换」", async () => {
    const path = join(dir, "lines.txt");
    writeFileSync(path, "l0\nl1\nl2\nl3\n");
    // 先 read 填 sharedData（模拟 read_file 后 write）
    await readSense.executor.execute({ path }, sharedData);
    const r = await exec({ path, content: "REPLACED", offset: 1, limit: 2 }, sharedData);
    expect(r.content).toContain("成功替换");
    expect(readFileSync(path, "utf-8")).toBe("l0\nREPLACED\nl3\n");
  });

  it("单独 offset（无 limit）→ 错误", async () => {
    const r = await exec({ path: join(dir, "x.txt"), content: "x", offset: 0 }, sharedData);
    expect(r.content).toContain("offset 和 limit 必须同时");
  });

  it("行范围但未 read（文件存在）→ 错误", async () => {
    const path = join(dir, "unread.txt");
    writeFileSync(path, "data\n");
    const r = await exec({ path, content: "x", offset: 0, limit: 1 }, sharedData);
    expect(r.content).toContain("先读取");
  });

  it("行范围文件不存在 → 错误", async () => {
    const r = await exec({ path: join(dir, "nope.txt"), content: "x", offset: 0, limit: 1 }, sharedData);
    expect(r.content).toContain("不存在");
  });
});

describe("write_file 错误路径", () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempDir();
    sharedData.clear();
  });
  afterEach(() => cleanupTempDir(dir));

  it("目录不存在 → ENOENT 错误", async () => {
    const r = await exec({ path: join(dir, "nodir", "x.txt"), content: "x" }, sharedData);
    expect(r.content).toContain("目录不存在");
  });

  it("已存在文件被外部修改（sharedData hash 不匹配）→ 警告", async () => {
    const path = join(dir, "modified.txt");
    writeFileSync(path, "original\n");
    await readSense.executor.execute({ path }, sharedData);
    // 模拟外部修改：追加内容改变 mtime/size
    writeFileSync(path, "original-changed\n");
    const r = await exec({ path, content: "overwrite" }, sharedData);
    expect(r.content).toContain("修改");
  });
});
