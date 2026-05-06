import { ChatOllama } from "@langchain/ollama";

/**
 * LLM 实例
 * 使用融合后的配置创建 ChatOllama 实例
 */
export function createLLM(): ChatOllama {
  return new ChatOllama({
    model: 'gemma4:e4b',
    baseUrl: "http://172.20.224.1:11434"
  });
}
