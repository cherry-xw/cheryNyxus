import { ToolManager, ensureCustomToolsLoaded } from "./tool/index";
import Middleware, {
  defaultHandlers,
  createLoopHandler,
  type MiddlewareChunk,
} from "./middleware/index";
import type { AdaptersGroup } from "@/core/middleware/types";
import config, { type AIServerConfig } from "@/utils/config";
import { randomUUID } from "crypto";

// Adapter 获取函数
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getToolAdapter } from "@/core/tool/adapter";

// Provider 注册函数（确保 adapter 已注册）
import { registerOpenAIAdapter } from "./provider/openai";
import { registerOllamaAdapter } from "./provider/ollama";

// 启动即完成注册
registerOpenAIAdapter();
registerOllamaAdapter();

/**
 * Agent Builder - 链式调用配置 agent
 */
export class AgentBuilder {
  private aiServerConfig?: AIServerConfig;
  private sessionId: string = randomUUID();
  private adapters?: AdaptersGroup;

  /**
   * 选择 LLM 服务（从 config.yaml 读取配置）
   * @param name config.yaml 中的客户端名称（如 "longcat"）
   */
  use(name: string): AgentBuilder {
    const aiServerConfig = config.llm.agent[name];
    if (!aiServerConfig) {
      throw new Error(`配置 "${name}" 不存在`);
    }
    this.aiServerConfig = aiServerConfig;

    // 根据 provider 注册 adapter（确保已注册）
    const provider = aiServerConfig.provider;

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
   * 构建 Agent 实例
   */
  async build(): Promise<Middleware<MiddlewareChunk>> {
    if (!this.aiServerConfig) {
      throw new Error("必须先调用 use() 选择 LLM 服务");
    }
    if (!this.adapters) {
      throw new Error("必须先调用 use() 初始化 adapters");
    }

    // 确保自定义工具已加载
    await ensureCustomToolsLoaded();

    // 解析 tool_group 配置
    const toolGroupNames = this.aiServerConfig.tool_group
      ? Array.isArray(this.aiServerConfig.tool_group)
        ? this.aiServerConfig.tool_group
        : [this.aiServerConfig.tool_group]
      : [];

    // 创建 ToolManager 并加载工具组
    const toolManager = new ToolManager(this.aiServerConfig.provider);
    toolManager.loadFromGroups(
      toolGroupNames,
      config.tool_groups,
      config.global.supervision,
    );

    // 预构建 tools（避免每次迭代重复构建）
    const builtTools = this.adapters.toolAdapter.buildTools(
      toolManager.getAll(),
    );

    return new Middleware<MiddlewareChunk>(
      this.sessionId,
      config.global,
      this.aiServerConfig,
      toolManager,
      this.adapters,
      defaultHandlers,
      createLoopHandler(config.global.maxLoopCount),
      builtTools,
    );
  }
}
