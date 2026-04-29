import config from "../config.json" with { type: "json" };

import { createOpenAIChat } from "./connect/index.ts";

async function main() {
  const chat = createOpenAIChat(config);

  const question = "请简单介绍一下你自己";

  console.log("问题:", question);
  console.log("\n回答: ");

  for await (const chunk of chat.stream(question)) {
    process.stdout.write(chunk);
  }

  console.log("\n");
}

main().catch(console.error);