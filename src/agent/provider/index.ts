import { registerOpenAIAdapter } from "./openai";
import { registerOllamaAdapter } from "./ollama";

let builtinProvidersRegistered = false;

/**
 * 注册内置 provider adapter。
 * 调用方在启动阶段显式执行，避免 import AgentBuilder 时产生注册副作用。
 */
export function registerBuiltinProviders(): void {
  if (builtinProvidersRegistered) {
    return;
  }

  registerOpenAIAdapter();
  registerOllamaAdapter();
  builtinProvidersRegistered = true;
}
