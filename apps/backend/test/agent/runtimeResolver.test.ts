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
import { z } from 'zod';
import { registerPluginSense } from '@/core/sense/senseRegistry.js';

describe("parseRuntimeSelection", () => {
  it("合法 → 返回 selection", () => {
    expect(parseRuntimeSelection({ brain: "mock_content", senseGroup: "auto_senses" }, "test")).toEqual({
      brain: "mock_content",
      senseGroup: "auto_senses",
      mcpServers: [],
    });
  });

  it("缺 brain → throw", () => {
    expect(() => parseRuntimeSelection({ senseGroup: "g" }, "test")).toThrow("必须选择一颗大脑");
  });

  it("缺 senseGroups → throw", () => {
    expect(() => parseRuntimeSelection({ brain: "mock_content" }, "test")).toThrow("需要配一个感官组");
  });

  it("空 senseGroups → throw", () => {
    expect(() => parseRuntimeSelection({ brain: "mock_content", senseGroup: "" }, "test")).toThrow("需要配一个感官组");
  });

  it("thinking 可选透传：设置时保留", () => {
    expect(
      parseRuntimeSelection({ brain: "mock_content", senseGroup: "auto_senses", thinking: "high" }, "test"),
    ).toEqual({
      brain: "mock_content",
      senseGroup: "auto_senses",
      mcpServers: [],
      thinking: "high",
    });
  });

  it("thinking 缺省不写字段（沿用大脑配置默认档位）", () => {
    expect(
      parseRuntimeSelection({ brain: "mock_content", senseGroup: "auto_senses" }, "test"),
    ).not.toHaveProperty("thinking");
  });
});

describe("RuntimeResolver.resolve", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("合法 → RuntimeConfig 含 brain/adapters/builtSenses/senseTable", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "auto_senses", mcpServers: [] });
    expect(r.brain.model).toBe("mock_content");
    expect(r.adapters.llmAdapter).toBeDefined();
    expect(r.adapters.messageAdapter).toBeDefined();
    expect(r.adapters.senseAdapter).toBeDefined();
    expect(r.builtSenses.length).toBeGreaterThan(0);
    expect(r.senseTable.has("read_file")).toBe(true);
  });

  it("thinking 覆盖生效：克隆 brain 并把档位盖到副本上，不污染原配置", () => {
    const r = new RuntimeResolver().resolve({
      brain: "mock_content",
      senseGroup: "auto_senses",
      mcpServers: [],
      thinking: "xhigh",
    });
    expect(r.brain.thinking).toBe("xhigh");
    // 覆盖语义为副本：原 config 的默认档位保持原样（xhigh 未写回全局）
    expect(config.llm.brain.mock_content!.thinking).not.toBe("xhigh");
  });

  it("thinking 缺省沿用大脑配置默认档位（不克隆改写）", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "auto_senses", mcpServers: [] });
    expect(r.brain.thinking).toBe(config.llm.brain.mock_content!.thinking);
  });

  it("brain 不存在 → throw", () => {
    expect(() => new RuntimeResolver().resolve({ brain: "nope", senseGroup: "auto_senses", mcpServers: [] })).toThrow("大脑");
  });

  it("sense group 不存在 → throw", () => {
    expect(() => new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "nope", mcpServers: [] })).toThrow("感官组");
  });

  it("group 含不存在 sense → 排除并说明原因", () => {
    config.sense_groups!["__test_missing"] = ["nonexistent_sense"];
    try {
      const runtime = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "__test_missing", mcpServers: [] });
      expect(runtime.builtSenses.some(tool => tool.function.name === 'nonexistent_sense')).toBe(false);
      expect(runtime.unavailableTools).toContainEqual(expect.objectContaining({ name: "nonexistent_sense", reason: "not_found" }));
    } finally {
      delete config.sense_groups!["__test_missing"];
    }
  });

  it("无效 level 后缀 → throw", () => {
    config.sense_groups!["__test_badlevel"] = ["read_file:invalid"];
    try {
      expect(() => new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "__test_badlevel", mcpServers: [] })).toThrow("无效");
    } finally {
      delete config.sense_groups!["__test_badlevel"];
    }
  });

  it("监管优先级：auto_senses（read_file:auto）→ auto", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "auto_senses", mcpServers: [] });
    expect(r.senseTable.get("read_file")?.supervisionLevel).toBe(SupervisionLevel.auto);
  });

  it("监管优先级：confirm_senses（write_file:smart）→ smart", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "confirm_senses", mcpServers: [] });
    expect(r.senseTable.get("write_file")?.supervisionLevel).toBe(SupervisionLevel.smart);
  });

  it("监管优先级：mixed_confirm（多 sense :smart）", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "mixed_confirm", mcpServers: [] });
    expect(r.senseTable.get("read_file")?.supervisionLevel).toBe(SupervisionLevel.smart);
    expect(r.senseTable.get("write_file")?.supervisionLevel).toBe(SupervisionLevel.smart);
  });

  it("builtSenses 数量 = senseTable 大小", () => {
    const r = new RuntimeResolver().resolve({ brain: "mock_content", senseGroup: "mixed_confirm", mcpServers: [] });
    expect(r.builtSenses.length).toBe(r.senseTable.size);
  });
  it('keeps operation selections strict in either order without exposing other actions',()=>{
    const schema=z.object({action:z.enum(['voice','reaction','poke'])}).strict();
    const definition={type:'function' as const,function:{name:'runtime_action',description:'fixture',parameters:z.toJSONSchema(schema) as any}};
    const release=registerPluginSense({definition,supervisionLevel:SupervisionLevel.auto,
      operationPolicy:{keys:['runtime_action.voice','runtime_action.reaction','runtime_action.poke'],key:args=>`runtime_action.${args.action}`,
        definition:keys=>({...definition,function:{...definition.function,parameters:z.toJSONSchema(z.object({action:z.enum(keys.map(key=>key.split('.')[1]!) as [string,...string[]])})) as any}})},
      executor:{schema,execute:async()=>({status:'ok',content:'fixture'})}},{source:'plugin'});
    try {
      for(const entries of [['runtime_action.voice:auto','runtime_action.voice:manual','runtime_action.reaction:auto'],['runtime_action.reaction:auto','runtime_action.voice:manual','runtime_action.voice:auto']]){
        config.sense_groups.__test_actions=entries;
        const r=new RuntimeResolver().resolve({brain:'mock_content',senseGroup:'__test_actions',mcpServers:[]});
        const tool=r.senseTable.get('runtime_action')!;
        expect(tool.operation?.({action:'voice'})).toMatchObject({allowed:true,level:SupervisionLevel.manual});
        expect(tool.operation?.({action:'reaction'})).toMatchObject({allowed:true,level:SupervisionLevel.auto});
        expect(tool.operation?.({action:'poke'})).toMatchObject({allowed:false});
        const parameters=r.builtSenses.find(tool=>tool.function.name==='runtime_action')?.function.parameters as any;
        expect(new Set(parameters.properties.action.enum)).toEqual(new Set(['voice','reaction']));
      }
    } finally { release();delete config.sense_groups.__test_actions; }
  });
});
