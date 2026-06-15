/**
 * checkpointMiddleware 集成测试（真实洋葱链 + mock provider）。
 *
 * 聚焦 chunk 归纳：consumed / 三 delta staged（thinking_end/content_end/sense_end）
 * / message_created effect / user input 注入。sense 执行细节见 tool.test.ts。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { bootstrapForTests, createAgent, runSend } from "../helpers/agentHarness.js";
import {
  stagedTypes,
  messageCreated,
  firstConsumed,
  collectContent,
  collectThinking,
  senseEnds,
  senseAccepts,
  hasDone,
} from "../helpers/chunkAssert.js";

describe("checkpointMiddleware 集成", () => {
  beforeAll(async () => {
    await bootstrapForTests();
  });

  it("content-only：consumed + thinking_end + content_end + message_created(user,assistant)", async () => {
    const agent = createAgent({ brain: "mock_content", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "你好");
    expect(firstConsumed(chunks)?.count).toBe(1);
    const staged = stagedTypes(chunks);
    expect(staged).toContain("thinking_end");
    expect(staged).toContain("content_end");
    const roles = messageCreated(chunks).map((m) => m.message.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(collectContent(chunks)).toContain("纯文本回复");
    expect(collectThinking(chunks)).toContain("思考");
    expect(hasDone(chunks)).toBe(true);
  });

  it("三 delta 顺序：thinking_end 在 content_end 之前", async () => {
    const agent = createAgent({ brain: "mock_content", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "顺序测试");
    const staged = stagedTypes(chunks);
    const tIdx = staged.indexOf("thinking_end");
    const cIdx = staged.indexOf("content_end");
    expect(tIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeGreaterThan(tIdx);
  });

  it("user input 注入 messages（consumed 携带 message）", async () => {
    const agent = createAgent({ brain: "mock_content", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "注入测试内容");
    const consumed = firstConsumed(chunks);
    expect(consumed?.count).toBe(1);
    expect(consumed?.messages?.[0]?.content).toBe("注入测试内容");
    expect(consumed?.messages?.[0]?.role).toBe("user");
  });

  it("auto sense：sense_end staged + sense_accept + sense 消息创建", async () => {
    const agent = createAgent({ brain: "mock_auto", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "读文件");
    const staged = stagedTypes(chunks);
    expect(staged).toContain("sense_end");
    expect(senseEnds(chunks).length).toBeGreaterThanOrEqual(1);
    expect(senseAccepts(chunks).length).toBeGreaterThanOrEqual(1);
    const roles = messageCreated(chunks).map((m) => m.message.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("sense");
  });

  it("纯 content 无 sense_end", async () => {
    const agent = createAgent({ brain: "mock_content", senseGroups: ["auto_senses"] });
    const chunks = await runSend(agent, "纯文本");
    expect(stagedTypes(chunks)).not.toContain("sense_end");
    expect(senseEnds(chunks)).toHaveLength(0);
  });
});
