import { describe, expect, it } from "vitest";
import { MessageJournal } from "@/core/middleware/messageJournal.js";
import { logger } from "@/utils/logger/index.js";
import type { SoulGroup } from "@/core/middleware/types.js";

describe("MessageJournal compact", () => {
  it("retains only the base system prompt and compact summary for future context", () => {
    const soul: SoulGroup = {
      chatId: "chat", senseSharedData: new Map(), userInputs: [], messages: [
        { id: "system", role: "system", content: "base", createdAt: 1, updateAt: 1 },
        { id: "old", role: "user", content: "old context", createdAt: 2, updateAt: 2 },
        { id: "compact", role: "user", content: "[[command:/compact]]", createdAt: 3, updateAt: 3 },
      ],
    };
    const journal = new MessageJournal(soul, logger);
    const summary = journal.appendAssistant({ content: "summary", thinking: "", senseCalls: [] });
    expect(summary.contextCompaction).toBe(true);
    expect(summary.contextCompactionTokens).toBeGreaterThan(0);

    journal.compactToLatestSummary();

    expect(journal.getMessages()).toHaveLength(2);
    expect(journal.getMessages()[1]).toMatchObject({ role: "system", content: expect.stringContaining("summary") });
  });
});
