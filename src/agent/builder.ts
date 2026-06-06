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
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getSenseAdapter } from "@/core/sense/adapter";

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
    const senseAdapter = getSenseAdapter(provider);

    if (!llmAdapter || !messageAdapter || !senseAdapter) {
      throw new Error(`Provider "${provider}" adapters not registered`);
    }

    this.adapters = { llmAdapter, messageAdapter, senseAdapter };

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
   * 构建 Agent 实例
   */
  async build(): Promise<Middleware<MiddlewareChunk>> {
    if (!this.brainConfig) {
      throw new Error("必须先调用 use() 选择 LLM 服务");
    }
    if (!this.adapters) {
      throw new Error("必须先调用 use() 初始化 adapters");
    }

    // 确保自定义感官已加载
    await ensureCustomSensesLoaded();

    // 解析 sense_group 配置
    const senseGroupNames = this.brainConfig.sense_group
      ? Array.isArray(this.brainConfig.sense_group)
        ? this.brainConfig.sense_group
        : [this.brainConfig.sense_group]
      : [];

    // 创建 SenseManager 并加载感官组
    const senseManager = new SenseManager(this.brainConfig.provider);
    senseManager.loadFromGroups(
      senseGroupNames,
      config.sense_groups,
      config.global.supervision,
    );

    // 预构建 senses（避免每次迭代重复构建）
    const builtSenses = this.adapters.senseAdapter.buildSenses(
      senseManager.getAll(),
    );

    return new Middleware<MiddlewareChunk>(
      this.soulId,
      config.global,
      this.brainConfig,
      senseManager,
      this.adapters,
      defaultHandlers,
      createLoopHandler(config.global.maxLoopCount),
      builtSenses,
    );
  }
}