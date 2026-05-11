import { ToolManager, getTools, ensureToolsLoaded, type Tool } from "@/tool/index";
import Middleware, { defaultHandlers, type AdaptersGroup } from "@/middleware/index";
import config, { type ClientConfig } from "@/config";
import { randomUUID } from "crypto";
import type { ZodType } from "zod";
import { initEnvInfo, resolvePath } from "@/utils/env.js";

// Adapter 获取函数
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getToolAdapter } from "@/core/tool/adapter";

// Provider 注册函数（确保 adapter 已注册）
import { registerOpenAIAdapter } from "@/provider/openai";
import { registerOllamaAdapter } from "@/provider/ollama";

const providerRegistry: Record<string, () => void> = {
  openai: registerOpenAIAdapter,
  ollama: registerOllamaAdapter,
};

/**
 * Agent Builder - 链式调用配置 agent
 */
export class AgentBuilder {
  private clientConfig?: ClientConfig;
  private sessionId: string = randomUUID();
  private adapters?: AdaptersGroup;
  private workDir?: string; // 自定义工作目录

  /**
   * 选择 LLM 服务（从 config.yaml 读取配置）
   * @param name config.yaml 中的客户端名称（如 "longcat"）
   */
  use(name: string): AgentBuilder {
    const clientConfig = config.llm.clients[name];
    if (!clientConfig) {
      throw new Error(`配置 "${name}" 不存在`);
    }
    this.clientConfig = clientConfig;

    // 根据 provider 注册 adapter（确保已注册）
    const provider = clientConfig.provider;
    if (providerRegistry[provider]) {
      providerRegistry[provider]();
    }

    // 获取 adapter 实例
    const llmAdapter = getLLMAdapter(provider);
    const messageAdapter = getMessageAdapter(provider);
    const toolAdapter = getToolAdapter(provider);

    if (!llmAdapter || !messageAdapter || !toolAdapter) {
      throw new Error(`Provider "${provider}" adapters not registered`);
    }

    this.adapters = { llmAdapter, messageAdapter, toolAdapter };

    return this;
  }

  /**
   * 设置会话 ID（可选）
   */
  setSessionId(id: string): AgentBuilder {
    this.sessionId = id;
    return this;
  }

  /**
   * 设置工作目录（可选）
   * @param dir 工作目录路径（绝对路径或相对路径）
   */
  setWorkDir(dir: string): AgentBuilder {
    this.workDir = dir;
    return this;
  }

  /**
   * 构建 Agent 实例
   */
  async build(): Promise<Middleware> {
    if (!this.clientConfig) {
      throw new Error("必须先调用 use() 选择 LLM 服务");
    }
    if (!this.adapters) {
      throw new Error("必须先调用 use() 初始化 adapters");
    }

    // 确保工具已加载
    await ensureToolsLoaded();

    // 初始化环境信息（使用自定义工作目录或 process.cwd()）
    initEnvInfo(this.workDir ? resolvePath(this.workDir) : process.cwd());

    // 根据 tool_group 配置加载工具（支持单个或多个工具组）
    const toolGroupNames = this.clientConfig.tool_group
      ? (Array.isArray(this.clientConfig.tool_group)
          ? this.clientConfig.tool_group
          : [this.clientConfig.tool_group])
      : [];

    let tools: Tool<ZodType>[] = [];

    for (const groupName of toolGroupNames) {
      const toolGroup = config.tool_groups?.[groupName];
      if (!toolGroup) {
        console.warn(`Tool group "${groupName}" not found, skipping`);
        continue;
      }

      const groupTools = getTools(toolGroup.tools);

      // 工具去重：后加载覆盖前加载
      for (const tool of groupTools) {
        const toolName = tool.definition.function.name;
        const existingIndex = tools.findIndex(
          (t) => t.definition.function.name === toolName
        );

        if (existingIndex >= 0) {
          console.warn(
            `Tool "${toolName}" already loaded, overriding with group "${groupName}"`
          );
          tools[existingIndex] = tool;
        } else {
          tools.push(tool);
        }
      }
    }

    // 创建 ToolManager 并添加工具
    const toolManager = new ToolManager(this.clientConfig.provider);
    if (tools.length > 0) {
      toolManager.add(tools);
    }

    return new Middleware(
      this.sessionId,
      config.global,
      this.clientConfig,
      toolManager,
      this.adapters,
      defaultHandlers,
    );
  }
}