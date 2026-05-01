import openai from "@/llm/openai";
import { v4 as uuid } from "uuid";

const chat = openai(uuid(), "longcat");

async function main() {
  console.log("Starting multi-turn conversation with LongCat (streaming)...");

  try {
    const threadId = uuid();

    // 流式调用演示
    for await (const chunk of chat.sendStream(threadId, "你好")) {
      if (!chunk.isDone) {
        if (!chunk.delta) {
          process.stdout.write(chunk.thinkingDelta);
        } else process.stdout.write(chunk.delta);
      } else {
        console.log("\n[Stream completed]");
      }
    }

    // 第二轮对话
    const threadId2 = uuid();
    for await (const chunk of chat.sendStream(threadId2, "计算二进制 1001+1011")) {
      if (!chunk.isDone) {
        if (!chunk.delta) {
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
