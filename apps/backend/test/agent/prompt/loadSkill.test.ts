/**
 * loadSkill 测试（agent/prompt/loadSkill）：getSkillMetas / getSkillRealtime / frontmatter 解析。
 *
 * 用临时 skills 目录（运行时改 config.global.skills_dir），不依赖 fixtures。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSkillMetas, getSkillRealtime, loadSkillFromFolder, prepareSkillActivation } from "@/agent/prompt/loadSkill.js";
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

    it("读取 skill 元数据（含完整技能指令的上下文 token 估算，含 content）", () => {
      writeSkill("alpha", "name: alpha\ndescription: alpha desc\ntrigger: 用户请求A", "alpha body content");
      const metas = getSkillMetas();
      expect(metas.length).toBe(1);
      expect(metas[0]!.name).toBe("alpha");
      expect(metas[0]!.description).toBe("alpha desc");
      expect(metas[0]!.trigger).toBe("用户请求A");
      expect(metas[0]!.contextTokens).toBeGreaterThan(0);
      expect(metas[0]!.content).toBe("alpha body content");
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
    it("loads typed required/optional capabilities through full and catalog loaders without changing the body", () => {
      writeSkill("drawing", "name: drawing\nrequires:\n  capabilities: [image.generate]\noptional:\n  capabilities: [image.inspect]", "original steps");
      const realtime = getSkillRealtime("drawing")!.skill;
      expect(realtime.requires).toEqual({ capabilities: ["image.generate"] });
      expect(realtime.optional).toEqual({ capabilities: ["image.inspect"] });
      expect(realtime.extra?.requires).toEqual({ capabilities: ["image.generate"] });
      expect(realtime.content).toBe("original steps");
      expect(loadSkillFromFolder(join(dir, "drawing"))?.requires).toEqual(realtime.requires);
      expect(getSkillMetas().find(skill => skill.name === "drawing")?.requires).toEqual(realtime.requires);
      const blocked = prepareSkillActivation(realtime);
      expect(blocked.check.canActivate).toBe(false);
      expect(blocked.content).toContain("image.generate");
      expect(blocked.content).not.toContain("original steps");
      const ready = prepareSkillActivation(realtime, operation => ({ operation, availability: operation === "image.generate" ? "requires_approval" : "unavailable", source: "role", mode: "tool", inputConstraints: {}, outputKinds: ["image"], reasonCode: "test", reason: "test", configRevision: "r1" }));
      expect(ready.check.canActivate).toBe(true);
      expect(ready.content).toContain("original steps");
      expect(ready.content).toContain("可选操作：image.inspect");
      expect(ready.content).toContain("执行前仍需审批：image.generate");
    });

    it("preserves invalid capability declarations for activation diagnostics", () => {
      writeSkill("invalid-deps", "name: invalid-deps\nrequires:\n  capabilities: [not.real]", "must not execute");
      const skill = getSkillRealtime("invalid-deps")!.skill;
      expect(skill.capabilityDependencyErrors).toHaveLength(1);
      expect(prepareSkillActivation(skill).check.canActivate).toBe(false);
      expect(prepareSkillActivation(skill).content).not.toContain("must not execute");
    });

    it("does not turn malformed dependency YAML into an undeclared skill", () => {
      writeSkill("broken-deps", "name: broken-deps\nrequires: [", "must not execute");
      const skill = getSkillRealtime("broken-deps")!.skill;
      expect(skill.capabilityDependencyErrors).toHaveLength(1);
      expect(prepareSkillActivation(skill).check.canActivate).toBe(false);
    });

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
