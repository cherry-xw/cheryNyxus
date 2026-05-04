import { sendStream } from "@/middleware/send";
import { v4 as uuid } from "uuid";
import config from "@/config";
import type { ClientConfigBase } from "@/llm/types";

const sessionId = uuid();

async function main() {
  console.log("Starting multi-turn conversation with Ollama (streaming)...");

  try {
    const threadId = uuid();
    const clientConfig = config.llm.clients.ollama as ClientConfigBase;

    // 流式调用演示
    for await (const chunk of sendStream(
      sessionId,
      threadId,
      "你好",
      clientConfig,
    )) {
      if (!chunk.isDone) {
        if (chunk.thinkingDelta) {
          process.stdout.write(chunk.thinkingDelta);
        } else process.stdout.write(chunk.delta);
      } else {
        console.log("\n[Stream completed]");
      }
    }

    // 第二轮对话
    const threadId2 = uuid();
    for await (const chunk of sendStream(
      sessionId,
      threadId2,
      "计算二进制 1001+1011",
      clientConfig,
    )) {
      if (!chunk.isDone) {
        if (chunk.thinkingDelta) {
          process.stdout.write(chunk.thinkingDelta);
        } else process.stdout.write(chunk.delta);
      } else {
        console.log("\n[Stream completed]");
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

main();