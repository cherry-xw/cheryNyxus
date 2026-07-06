import { describe, it, expect } from "vitest";
import { SenseCallAssembler } from "@/agent/middleware/senseCallAssembler";

/**
 * SenseCallAssembler 单测：锁住 provider delta 合并语义。
 * 覆盖：单工具多片 arguments、多工具 index 切换、非流式完整 tool call、id/name 首个不覆盖、排序。
 */
describe("SenseCallAssembler", () => {
  it("单工具多片 arguments：同 index 累积 arguments（OpenAI 流式）", () => {
    const asm = new SenseCallAssembler();
    asm.push({ index: 0, id: "call-1", name: "read_file", arguments: "" });
    asm.push({ index: 0, id: "", name: "", arguments: '{"path":"a' });
    asm.push({ index: 0, id: "", name: "", arguments: '.txt"}' });
    const result = asm.toArray();
    expect(result).toHaveLength(1);
    expect(result[0]!.arguments).toBe('{"path":"a.txt"}');
    expect(result[0]!.name).toBe("read_file");
    expect(result[0]!.id).toBe("call-1");
  });

  it("多工具 index 切换：flushCompletedOnIndexChange 返回已完成项并移除", () => {
    const asm = new SenseCallAssembler();
    asm.push({ index: 0, id: "call-1", name: "read_file", arguments: '{"path":"a"}' });
    // 切换到 index 1 → 上一项已完成
    const flushed = asm.flushCompletedOnIndexChange({ index: 1, id: "call-2", name: "execute_command", arguments: "" });
    expect(flushed).not.toBeNull();
    expect(flushed!.name).toBe("read_file");
    expect(flushed!.arguments).toBe('{"path":"a"}');
    asm.push({ index: 1, id: "call-2", name: "execute_command", arguments: '{"command":"ls"}' });
    const rest = asm.toArray();
    expect(rest).toHaveLength(1);
    expect(rest[0]!.name).toBe("execute_command");
  });

  it("非流式完整 tool call：单 push 返回完整项（Ollama/mock）", () => {
    const asm = new SenseCallAssembler();
    asm.push({ index: 0, id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' });
    const result = asm.toArray();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' });
  });

  it("id/name 取首个非空，后续 delta 不覆盖", () => {
    const asm = new SenseCallAssembler();
    asm.push({ index: 0, id: "first", name: "read_file", arguments: "" });
    asm.push({ index: 0, id: "second", name: "other", arguments: "{}" });
    const result = asm.toArray();
    expect(result[0]!.id).toBe("first");
    expect(result[0]!.name).toBe("read_file");
    expect(result[0]!.arguments).toBe("{}");
  });

  it("flushCompletedOnIndexChange：无 name 的项返回 null（不视为有效 sense call）", () => {
    const asm = new SenseCallAssembler();
    asm.push({ index: 0, id: "call-1", name: "", arguments: "" });
    const flushed = asm.flushCompletedOnIndexChange({ index: 1, id: "call-2", name: "execute_command", arguments: "" });
    expect(flushed).toBeNull();
  });

  it("flushCompletedOnIndexChange：首项无切换返回 null", () => {
    const asm = new SenseCallAssembler();
    const flushed = asm.flushCompletedOnIndexChange({ index: 0, id: "call-1", name: "read_file", arguments: "" });
    expect(flushed).toBeNull();
  });

  it("toArray：按 index 升序返回", () => {
    const asm = new SenseCallAssembler();
    asm.push({ index: 2, id: "c3", name: "c", arguments: "" });
    asm.push({ index: 0, id: "c1", name: "a", arguments: "" });
    asm.push({ index: 1, id: "c2", name: "b", arguments: "" });
    const result = asm.toArray();
    expect(result.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});
