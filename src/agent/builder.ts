import { SenseManager, ensureCustomSensesLoaded } from "./sense/index";
import Middleware, {
  defaultHandlers,
  createLoopHandler,
  type MiddlewareChunk,
} from "./middleware/index";
import type { AdaptersGroup } from "@/core/middleware/types";
import config, { type BrainConfig } from "@/utils/config";
import { randomUUID } from "crypto";

// Adapter 获取函数
import { getLLMAdapter } from "@/core/llm/index";
import { getMessageAdapter } from "@/core/message/index";

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
  private brainConfig?: BrainConfig;
  private soulId: string = randomUUID();
  private senseGroup?: string;
  private adapters?: AdaptersGroup;

  /**
   * 选择 LLM 服务（从 config.yaml 读取配置）
   * @param name config.yaml 中的客户端名称（如 "longcat"）
   */
  use(name: string): AgentBuilder {
    const brainConfig = config.llm.brain[name];
    if (!brainConfig) {
      throw new Error(`配置 "${name}" 不存在`);
    }
    this.brainConfig = brainConfig;

    // 根据 provider 注册 adapter（确保已注册）
    const provider = brainConfig.provider;

    // 获取 adapter 实例
    const llmAdapter = getLLMAdapter(provider);
    const messageAdapter = getMessageAdapter(provider);

    if (!llmAdapter || !messageAdapter) {
      throw new Error(`Provider "${provider}" adapters not registered`);
    }

    this.adapters = { llmAdapter, messageAdapter };

    return this;
  }

  /**
   * 设置灵魂 ID（可选）
   */
  setSoulId(id: string): AgentBuilder {
    this.soulId = id;
    return this;
  }

  /**
   * 设置 sense group（必填）
   * @param groupName sense group 名称
   */
  setSenseGroup(groupName: string): AgentBuilder {
    this.senseGroup = groupName;
    return this;
  }

  /**
   * 构建 Agent 实例
   */
  async build(): Promise<Middleware<MiddlewareChunk>> {
    if (!this.brainConfig) {
      throw new Error("必须先调用 use() 选择 LLM 服务");
    }
    if (!this.adapters) {
      throw new Error("必须先调用 use() 初始化 adapters");
    }
    if (!this.senseGroup) {
      throw new Error("必须先调用 setSenseGroup() 选择感官组");
    }

    // 确保自定义感官已加载
    await ensureCustomSensesLoaded();

    // 创建 SenseManager 并加载感官组
    const senseManager = new SenseManager(this.brainConfig.provider);
    senseManager.loadFromGroups(
      this.senseGroup,
      config.sense_groups,
      config.global.supervision,
    );

    return new Middleware<MiddlewareChunk>(
      this.soulId,
      config.global,
      this.brainConfig,
      senseManager,
      this.adapters,
      defaultHandlers,
      createLoopHandler(config.global.maxLoopCount)
    );
  }
}
