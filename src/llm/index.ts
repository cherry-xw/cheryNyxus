import createOllamaClient from "@/provider/ollama";
import createOpenAIClient from "@/provider/openai";

export { BaseLLMClient } from "./base";
export * from "./types";

export default {
  ollama: createOllamaClient,
  openai: createOpenAIClient,
};