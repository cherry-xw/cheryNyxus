/**
 * listPrompts 单元测试：递归遍历 .chery/prompt/ 收集角色 override .md 文件。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { listPrompts } from "@/agent/prompt/listPrompts.js";
import config from "@/utils/config.js";

describe("listPrompts", () => {
  const promptsDir = config.global.prompts_dir;
  const cheryDir = join(promptsDir, "..");

  beforeEach(() => {
    // 确保测试隔离：清理 + 重建
    if (existsSync(promptsDir)) rmSync(promptsDir, { recursive: true, force: true });
    mkdirSync(promptsDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(promptsDir)) rmSync(promptsDir, { recursive: true, force: true });
  });

  it("空目录 → []", () => {
    expect(listPrompts()).toEqual([]);
  });

  it("目录不存在 → []", () => {
    rmSync(promptsDir, { recursive: true, force: true });
    expect(listPrompts()).toEqual([]);
  });

  it("收集 .md 文件（相对 .chery/ 路径）", () => {
    writeFileSync(join(promptsDir, "role1.md"), "role1");
    writeFileSync(join(promptsDir, "role2.md"), "role2");
    const result = listPrompts();
    expect(result).toContain("prompt/role1.md");
    expect(result).toContain("prompt/role2.md");
  });

  it("排除 system.md（全局 base）", () => {
    writeFileSync(join(promptsDir, "system.md"), "base");
    writeFileSync(join(promptsDir, "role1.md"), "role1");
    const result = listPrompts();
    expect(result).not.toContain("prompt/system.md");
    expect(result).toContain("prompt/role1.md");
  });

  it("支持子文件夹", () => {
    const subDir = join(promptsDir, "subfolder");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "nested.md"), "nested");
    const result = listPrompts();
    expect(result).toContain("prompt/subfolder/nested.md");
  });

  it("忽略非 .md 文件", () => {
    writeFileSync(join(promptsDir, "notes.txt"), "text");
    writeFileSync(join(promptsDir, "data.json"), "{}");
    writeFileSync(join(promptsDir, "role.md"), "role");
    const result = listPrompts();
    expect(result).toEqual(["prompt/role.md"]);
  });

  it("结果排序", () => {
    writeFileSync(join(promptsDir, "b.md"), "b");
    writeFileSync(join(promptsDir, "a.md"), "a");
    const result = listPrompts();
    expect(result).toEqual(["prompt/a.md", "prompt/b.md"]);
  });
});
