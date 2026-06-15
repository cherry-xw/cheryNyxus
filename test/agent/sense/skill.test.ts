/**
 * skill sense 测试（执行器单元）。
 *
 * skill sense 调 getSkillRealtime(name) 实时读 config.global.skills_dir。
 * 测试用临时 skills 目录 + skill.md，运行时改 config.global.skills_dir 指向。
 *
 * 覆盖：
 * - 存在 skill → content 含「技能已激活」+ 指令，hash 非空
 * - 不存在 skill → error content
 * - supervision = auto
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import skillSense from "@/agent/sense/skill.js";
import { SupervisionLevel } from "@/core/config.js";
import config from "@/utils/config.js";
import { createTempDir, cleanupTempDir } from "../../helpers/tempDir.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const exec = skillSense.executor.execute.bind(skillSense.executor);

describe("skill sense 定义", () => {
  it("name = skill，supervision = auto", () => {
    expect(skillSense.definition.function.name).toBe("skill");
    expect(skillSense.supervisionLevel).toBe(SupervisionLevel.auto);
  });
});

describe("skill 执行", () => {
  let dir: string;
  let origSkillsDir: string;
  beforeEach(() => {
    dir = createTempDir();
    origSkillsDir = config.global.skills_dir;
    config.global.skills_dir = dir;
  });
  afterEach(() => {
    cleanupTempDir(dir);
    config.global.skills_dir = origSkillsDir;
  });

  it("存在 skill → content 含「技能已激活」+ 指令，hash 非空", async () => {
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir);
    writeFileSync(
      join(skillDir, "skill.md"),
      "---\nname: my-skill\ndescription: 测试技能\ntrigger: 用户请求测试\n---\n严格遵守此指令XYZ123\n",
    );
    const r = await exec({ name: "my-skill" }, new Map());
    expect(r.content).toContain("my-skill");
    expect(r.content).toContain("技能已激活");
    expect(r.content).toContain("严格遵守此指令XYZ123");
    expect(r.hash).not.toBe("");
  });

  it("不存在 skill → error content + hash 空", async () => {
    const r = await exec({ name: "nonexistent-skill" }, new Map());
    expect(r.content).toContain("not found");
    expect(r.hash).toBe("");
  });

  it("skills 目录不存在 → error content", async () => {
    cleanupTempDir(dir);
    const r = await exec({ name: "any" }, new Map());
    expect(r.content).toContain("not found");
  });
});
