import { ensureCustomSensesLoaded } from "@/agent/sense/index";
import Middleware, {
  defaultHandlers,
  createLoopHandler,
  type MiddlewareChunk,
} from "./middleware/index";
import type { AdaptersGroup, SenseEntry } from "@/core/middleware/types";
import type { BrainConfig } from "@/utils/config";
import type { Sense, SenseFunction } from "@/core/sense";
import type { ZodType } from "zod";
import config from "@/utils/config";
import { getLLMAdapter } from "@/core/llm/index";
import { getMessageAdapter } from "@/core/message/index";
import { getSenseAdapter } from "@/core/sense/adapter";
import { getSenses } from "@/core/sense";
import { logger } from "@/utils/logger/index.js";

// Provider 注册函数（确保 adapter 已注册）
import { registerOpenAIAdapter } from "./provider/openai";
import { registerOllamaAdapter } from "./provider/ollama";

// 启动即完成注册
registerOpenAIAdapter();
registerOllamaAdapter();

/** 自定义感官加载标志（幂等） */
let sensesLoaded = false;

/**
 * AgentBuilder - RuntimeConfig 工厂 + Middleware 工厂
 *
 * 解耦后职责：
 * - 不再返回绑死 brain/sense 的 Middleware 实例
 * - 提供无状态 resolve 方法：resolveBrain / resolveSense
 * - Middleware 实例由 service 层通过 createMiddleware 创建（每 chat 一个，跨轮不重建）
 * - brain/sense 由 service 层 resolve 后通过 Middleware.setBrain/setSense 注入
 */
export class AgentBuilder {
  /**
   * 确保自定义感官已编译加载（幂等，首次调用阻塞加载）
   */
  static async ensureSensesLoaded(): Promise<void> {
    if (!sensesLoaded) {
      await ensureCustomSensesLoaded();
      sensesLoaded = true;
    }
  }

  /**
   * 创建空 Middleware 实例（service 层每 chat 一个，跨轮不重建）
   * 构造只注入跨轮不变项：global + handlers + loopHandler
   */
  createMiddleware(): Middleware<MiddlewareChunk> {
    return new Middleware<MiddlewareChunk>(
      config.global,
      defaultHandlers,
      createLoopHandler(config.global.maxLoopCount),
    );
  }

  /**
   * resolve brain 名称 → brain 配置 + adapters（llm/message/sense）
   * provider 决定三个 adapter，从各自注册表获取。
   */
  resolveBrain(name: string): { brain: BrainConfig; adapters: AdaptersGroup } {
    const brain = config.llm.brain[name];
    if (!brain) {
      throw new Error(`配置 "${name}" 不存在`);
    }

    const provider = brain.provider;
    const llmAdapter = getLLMAdapter(provider);
    const messageAdapter = getMessageAdapter(provider);
    const senseAdapter = getSenseAdapter(provider);

    if (!llmAdapter || !messageAdapter || !senseAdapter) {
      throw new Error(`Provider "${provider}" adapters not registered`);
    }

    return {
      brain,
      adapters: { llmAdapter, messageAdapter, senseAdapter },
    };
  }

  /**
   * resolve senseGroups → builtSenses（给 LLM）+ senseTable（监管等级 + 执行器）
   *
   * 摊平原 SenseManager.loadFromGroups + getAll + buildSenses 逻辑：
   * - 监管优先级：sense_group > 前组已解析 > 感官内置 > global
   * - buildSenses 用 brain.provider 对应的 senseAdapter
   * - senseTable 摊平为 name → { supervisionLevel, execute }，运行期无需 SenseManager
   *
   * @param provider brain.provider，决定 senseAdapter
   * @param senseGroups 感官组名称列表（前端选择，每轮可换）
   */
  resolveSense(
    provider: string,
    senseGroups: string[],
  ): { builtSenses: SenseFunction[]; senseTable: Map<string, SenseEntry> } {
    const senseAdapter = getSenseAdapter(provider);
    if (!senseAdapter) {
      throw new Error(`Sense adapter for provider "${provider}" not registered`);
    }
    if (!this.senseGroup) {
      throw new Error("必须先调用 setSenseGroup() 选择感官组");
    }

    // 按组加载 + 监管优先级解析（摊平 loadFromGroups）
    const resolved = new Map<string, Sense<ZodType>>();
    for (const groupName of senseGroups) {
      const group = config.sense_groups?.[groupName];
      if (!group) {
        logger.warn(`Sense group "${groupName}" not found, skipping`);
        continue;
      }

      for (const original of getSenses(group.senses)) {
        const name = original.definition.function.name;
        const prev = resolved.get(name);
        if (prev) {
          logger.warn(`Sense "${name}" already loaded, overriding with group "${groupName}"`);
        }
        // shallow copy 隔离：supervisionLevel 写入不得污染全局 senseRegistry（多 chat 共享）
        const s: Sense<ZodType> = { ...original };
        // 优先级：组监管 > 前组已解析监管 > 感官内置监管 > 全局默认
        s.supervisionLevel =
          group.supervision ?? prev?.supervisionLevel ?? s.supervisionLevel ?? config.global.supervision;
        resolved.set(name, s);
      }
    }

    const senses = [...resolved.values()];

    // 构建 LLM function 列表
    const builtSenses = senseAdapter.buildSenses(senses);

    // 摊平为运行时查找表
    const senseTable = new Map<string, SenseEntry>();
    for (const s of senses) {
      const name = s.definition.function.name;
      senseTable.set(name, {
        supervisionLevel: s.supervisionLevel ?? config.global.supervision,
        execute: (args, sharedData) =>
          s.executor.execute(
            args as Parameters<typeof s.executor.execute>[0],
            sharedData,
          ),
      });
    }

    return { builtSenses, senseTable };
  }
}
