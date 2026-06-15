/**
 * buildFirstSystemPrompt 测试（agent/prompt/index）。
 *
 * 构造首条 system prompt：<system-reminder>{system.md}</system-reminder> + <environment> + <skills>。
 * 复用 flows/fixtures/.chery/system.md（全局 setupFiles 已设 CHERY_DIR）。
 */
import { describe, it, expect } from "vitest";
import buildFirstSystemPrompt from "@/agent/prompt/index.js";

describe("buildFirstSystemPrompt", () => {
  it("含 <system-reminder> 包裹 system.md 内容", () => {
    const prompt = buildFirstSystemPrompt();
    expect(prompt).toContain("<system-reminder>");
    expect(prompt).toContain("</system-reminder>");
    expect(prompt).toContain("test assistant");
  });

  it("含 <environment> 块（OS / 日期 / 时间）", () => {
    const prompt = buildFirstSystemPrompt();
    expect(prompt).toContain("<environment>");
    expect(prompt).toContain("操作系统:");
    expect(prompt).toContain("当前日期:");
    expect(prompt).toContain("当前时间:");
  });

  it("含 <skills> 块（无 skills 时为空 section）", () => {
    const prompt = buildFirstSystemPrompt();
    expect(prompt).toContain("<skills>");
    expect(prompt).toContain("</skills>");
  });

  it("整体结构：system-reminder → environment → skills 顺序", () => {
    const prompt = buildFirstSystemPrompt();
    const reminderIdx = prompt.indexOf("<system-reminder>");
    const envIdx = prompt.indexOf("<environment>");
    const skillsIdx = prompt.indexOf("<skills>");
    expect(reminderIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeGreaterThan(reminderIdx);
    expect(skillsIdx).toBeGreaterThan(envIdx);
  });
});
