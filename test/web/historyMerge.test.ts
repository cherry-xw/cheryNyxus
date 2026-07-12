import { describe, expect, it } from "vitest";
import {
  collectDescendantChatIds,
  mergeChildReplyHistory,
} from "../../web/src/stores/agents/historyMerge";

describe("historyMerge", () => {
  it("merges only a child's final response with the identical parent return", () => {
    const items = [
      {
        role: "role" as const,
        content: "正在检索资料",
        subPetChatId: "child-1",
        callerSubPetChatId: "main",
        createdAt: 10,
        msgId: "child-step",
      },
      {
        role: "role" as const,
        content: "最终结论",
        thinking: "完成推理",
        senseCalls: [{ name: "search", status: "done" as const }],
        subPetChatId: "child-1",
        callerSubPetChatId: "main",
        createdAt: 20,
        msgId: "child-final",
      },
      {
        role: "role" as const,
        content: "最终结论",
        createdAt: 25,
        msgId: "parent-return",
      },
    ];

    const merged = mergeChildReplyHistory(items);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ content: "正在检索资料", msgId: "child-step" });
    expect(merged[1]).toMatchObject({
      content: "最终结论",
      thinking: "完成推理",
      subPetChatId: "child-1",
      callerSubPetChatId: "main",
      createdAt: 25,
      msgId: "parent-return",
      mergedView: "child-to-master",
    });
  });

  it("keeps rows separate when identical text cannot be attributed uniquely", () => {
    const items = [
      { role: "role" as const, content: "完成", subPetChatId: "child-1", createdAt: 10 },
      { role: "role" as const, content: "完成", subPetChatId: "child-2", createdAt: 10 },
      { role: "role" as const, content: "完成", createdAt: 20 },
    ];

    expect(mergeChildReplyHistory(items)).toHaveLength(3);
  });

  it("collects every descendant once and ignores an invalid parent cycle", () => {
    const chats = [
      { chatId: "main" },
      { chatId: "child", parentChatId: "main" },
      { chatId: "grandchild", parentChatId: "child" },
      { chatId: "loop", parentChatId: "grandchild" },
      { chatId: "child", parentChatId: "loop" },
    ];

    expect(collectDescendantChatIds(chats, "main")).toEqual([
      "child",
      "grandchild",
      "loop",
    ]);
  });
});
