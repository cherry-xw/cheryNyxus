import type { LLMClient, ClientConfigBase } from "@/llm/types";
import type { Tool } from "@/tool/toolCreator";
import type { ZodType } from "zod";
import type { ToolGroupConfig } from "@/config";
import llm from "@/llm/index";
import config from "@/config";
import { randomUUID } from "crypto";
import { SupervisionLevel } from "@/llm/types";

/**
 * Agent Builder - 链式调用配置 agent
 */
export class AgentBuilder {
  private clientConfig?: ClientConfigBase;
  private tools: Tool<ZodType>[] = [];
  private sessionId: string = randomUUID();
  /** 允许自动执行的监管等级（从tool_group配置读取） */
  private autoExecuteLevel?: SupervisionLevel;

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

    // 自动根据 tool_group 配置绑定 tools 和 autoExecuteLevel
    const toolGroupName = clientConfig.tool_group;
    if (toolGroupName && config.tool_groups?.[toolGroupName]) {
      const toolGroup = config.tool_groups[toolGroupName];
      this.autoExecuteLevel = SupervisionLevel[toolGroup.auto_execute_level];
      // Tool绑定将在build()中根据toolGroup.tools列表筛选
    }

    return this;
  }

  /**
   * 绑定工具（单个或数组）
   */
  bindTools(tool: Tool<ZodType> | Tool<ZodType>[]): AgentBuilder {
    const toolsArray = Array.isArray(tool) ? tool : [tool];
    this.tools.push(...toolsArray);
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
  build(): Agent {
    if (!this.clientConfig) {
      throw new Error("必须先调用 use() 选择 LLM 服务");
    }

    // 根据 provider 字段选择对应的工厂函数
    const provider = this.clientConfig.provider as keyof typeof llm;
    const factory = llm[provider];
    if (!factory) {
      throw new Error(`provider "${provider}" 不支持`);
    }

    // 根据 tool_group 筛选 tools
    const toolGroupName = this.clientConfig.tool_group;
    let filteredTools = this.tools;
    if (toolGroupName && config.tool_groups?.[toolGroupName]) {
      const toolGroup = config.tool_groups[toolGroupName];
      filteredTools = this.tools.filter(t =>
        toolGroup.tools.includes(t.definition.function.name)
      );
    }

    // 设置 autoExecuteLevel 到 clientConfig（仅在有值时添加）
    const enhancedConfig = {
      ...this.clientConfig,
      ...(this.autoExecuteLevel !== undefined && { autoExecuteLevel: this.autoExecuteLevel }),
    };

    // 创建 client（工厂函数签名：sessionId + config）
    const client = factory(this.sessionId, enhancedConfig);

    // 绑定筛选后的工具
    if (filteredTools.length > 0) {
      client.tool.add(filteredTools);
    }

    return new Agent(client);
  }
}

/**
 * Agent 实例 - 封装 LLM 客户端，提供 send/sendStream/confirmToolCall 方法
 */
export class Agent {
  constructor(private client: LLMClient<ClientConfigBase>) {}

  /**
   * 发送消息（两阶段执行）
   * - 自动执行监管等级 ≤ autoExecuteLevel 的 tool
   * - 需确认的 tool 返回 ToolCallPending 状态
   */
  async send(threadId: string, input: string) {
    return this.client.send(threadId, input);
  }

  /**
   * 确认执行待定的 tool 调用
   * @param approved 用户是否批准执行
   */
  async confirmToolCall(approved: boolean) {
    return this.client.confirmToolCall(approved);
  }

  /**
   * 发送消息（流式）
   */
  async *sendStream(threadId: string, input: string) {
    return this.client.sendStream(threadId, input);
  }
}

/**
 * 创建 AgentBuilder 实例
 */
export function createAgent(): AgentBuilder {
  return new AgentBuilder();
}