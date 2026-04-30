import { StateSchema, ReducedValue, MessagesValue } from "@langchain/langgraph";
import { z } from "zod"; // 使用 Zod 定义结构

// 这是代理的主要状态，您可以在其中存储任何信息
export const AgentState = new StateSchema({
  // 消息字段，使用内置的 MessagesValue
  messages: MessagesValue,
  // 普通字段，用 zod 定义类型
  userQuery: z.string(),
  // 需要累加的字段，用 ReducedValue 包装 reducer 逻辑
  totalTokens: new ReducedValue(z.number().default(0), {
    inputSchema: z.number(),
    reducer: (current, next) => current + next,
  }),
});