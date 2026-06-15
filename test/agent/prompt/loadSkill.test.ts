/**
 * loadSkill 测试（agent/prompt/loadSkill）：getSkillMetas / getSkillRealtime / frontmatter 解析。
 *
 * 用临时 skills 目录（运行时改 config.global.skills_dir），不依赖 fixtures。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSkillMetas, getSkillRealtime } from "@/agent/prompt/loadSkill.js";
import config from "@/utils/config.js";
import { createTempDir, cleanupTempDir } from "../../helpers/tempDir.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

describe("loadSkill", () => {
  let dir: string;
  let origDir: string;
  beforeEach(() => {
    dir = createTempDir();
    origDir = config.global.skills_dir;
    config.global.skills_dir = dir;
  });
  afterEach(() => {
    cleanupTempDir(dir);
    config.global.skills_dir = origDir;
  });

  function writeSkill(name: string, frontmatter: string, body: string): void {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "skill.md"), `---\n${frontmatter}\n---\n${body}`);
  }

  describe("getSkillMetas", () => {
    it("空目录 → []", () => {
      expect(getSkillMetas()).toEqual([]);
    });

    it("目录不存在 → []", () => {
      cleanupTempDir(dir);
      expect(getSkillMetas()).toEqual([]);
    });

    it("读取 skill 元数据（name + description + trigger，不含 content）", () => {
      writeSkill("alpha", "name: alpha\ndescription: alpha desc\ntrigger: 用户请求A", "alpha body content");
      const metas = getSkillMetas();
      expect(metas.length).toBe(1);
      expect(metas[0]!.name).toBe("alpha");
      expect(metas[0]!.description).toBe("alpha desc");
      expect(metas[0]!.trigger).toBe("用户请求A");
      expect((metas[0] as { content?: string }).content).toBeUndefined();
    });

    it("实时读取（改文件后反映）", () => {
      writeSkill("beta", "name: beta\ndescription: v1", "body");
      expect(getSkillMetas()[0]!.description).toBe("v1");
      writeSkill("beta", "name: beta\ndescription: v2", "body");
      expect(getSkillMetas()[0]!.description).toBe("v2");
    });
  });

  describe("getSkillRealtime", () => {
    it("存在 skill → 返回 skill + size + mtimeMs", () => {
      writeSkill("gamma", "name: gamma\ndescription: g", "gamma content XYZ");
      const r = getSkillRealtime("gamma");
      expect(r).toBeDefined();
      expect(r!.skill.name).toBe("gamma");
      expect(r!.skill.content).toContain("gamma content XYZ");
      expect(r!.size).toBeGreaterThan(0);
      expect(r!.mtimeMs).toBeGreaterThan(0);
    });

    it("不存在 → undefined", () => {
      expect(getSkillRealtime("nonexistent")).toBeUndefined();
    });

    it("目录不存在 → undefined", () => {
      cleanupTempDir(dir);
      expect(getSkillRealtime("any")).toBeUndefined();
    });
  });

  describe("frontmatter 解析", () => {
    it("无 frontmatter → 用目录名做 name，整段做 content", () => {
      const skillDir = join(dir, "plain");
      mkdirSync(skillDir);
      writeFileSync(join(skillDir, "skill.md"), "no frontmatter body");
      const r = getSkillRealtime("plain");
      expect(r?.skill.name).toBe("plain");
      expect(r?.skill.content).toContain("no frontmatter body");
    });
  });
});
