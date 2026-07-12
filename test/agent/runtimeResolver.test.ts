/**
 * RuntimeResolver 测试：parseRuntimeSelection + resolve（brain/senseGroups 原子解析）。
 *
 * 复用 flows/fixtures config + bootstrapForTests（注册 provider + 内置 senses）。
 *
 * 覆盖：
 * - parseRuntimeSelection 校验（缺 brain / 缺 senseGroups / 空）
 * - resolve 合法 → RuntimeConfig（brain/adapters/builtSenses/senseTable）
 * - resolve 错误（brain 不存在 / sense group 不存在 / sense 不存在 / 无效 level）
 * - 监管优先级：senseGroups :level 覆盖（auto_senses/confirm_senses/mixed_confirm）
 */
import { describe, it, expect, beforeAll } from "vitest";
import { RuntimeResolver, parseRuntimeSelection } from "@/agent/runtimeResolver.js";
import { SupervisionLevel } from "@/core/config.js";
import config from "@/utils/config.js";
import { bootstrapForTests } from "./helpers/agentHarness.js";

describe("parseRuntimeSelection", () => {
  it("合法 → 返回 selection", () => {
    expect(parseRuntimeSelection({ brain: "b", senseGroup: "g" }, "test")).toEqual({
      brain: "b",
      senseGroup: "g",
    });
  });

  it("缺 brain → throw", () => {
    expect(() => parseRuntimeSelection({ senseGroup: "g" }, "test")).toThrow();
  });

  it("缺 senseGroups → throw", () => {
    expect(() => parseRuntimeSelection({ brain: "b" }, "test")).toThrow();
  });

  it("空 senseGroups → throw", () => {
    expect(() => parseRuntimeSelection({ brain: "b", senseGroup: "" }, "test")).toThrow();
  });
});

describe("RuntimeResolver.resolve", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("合法 → RuntimeConfig 含 brain/adapters/builtSenses/senseTable", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "auto_senses" });
    expect(r.brain.model).toBe("mock_content");
    expect(r.adapters.llmAdapter).toBeDefined();
    expect(r.adapters.messageAdapter).toBeDefined();
    expect(r.adapters.senseAdapter).toBeDefined();
    expect(r.builtSenses.length).toBeGreaterThan(0);
    expect(r.senseTable.has("read_file")).toBe(true);
  });

  it("brain 不存在 → throw", () => {
    expect(() => new RuntimeResolver().resolve({ brain: "nope", senseGroup: "auto_senses" })).toThrow("Brain");
  });

  it("sense group 不存在 → throw", () => {
    expect(() => new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "nope" })).toThrow("Sense group");
  });

  it("group 含不存在 sense → throw", () => {
    config.sense_groups!["__test_missing"] = ["nonexistent_sense"];
    try {
      expect(() => new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "__test_missing" })).toThrow("Sense");
    } finally {
      delete config.sense_groups!["__test_missing"];
    }
  });

  it("无效 level 后缀 → throw", () => {
    config.sense_groups!["__test_badlevel"] = ["read_file:invalid"];
    try {
      expect(() => new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "__test_badlevel" })).toThrow("无效");
    } finally {
      delete config.sense_groups!["__test_badlevel"];
    }
  });

  it("监管优先级：auto_senses（read_file:auto）→ auto", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "auto_senses" });
    expect(r.senseTable.get("read_file")?.supervisionLevel).toBe(SupervisionLevel.auto);
  });

  it("监管优先级：confirm_senses（write_file:confirm）→ confirm", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "confirm_senses" });
    expect(r.senseTable.get("write_file")?.supervisionLevel).toBe(SupervisionLevel.confirm);
  });

  it("监管优先级：mixed_confirm（多 sense :confirm）", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "mixed_confirm" });
    expect(r.senseTable.get("read_file")?.supervisionLevel).toBe(SupervisionLevel.confirm);
    expect(r.senseTable.get("write_file")?.supervisionLevel).toBe(SupervisionLevel.confirm);
  });

  it("builtSenses 数量 = senseTable 大小", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "mixed_confirm" });
    expect(r.builtSenses.length).toBe(r.senseTable.size);
  });
});
