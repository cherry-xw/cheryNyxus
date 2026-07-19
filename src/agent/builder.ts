import AgentSession, {
  defaultHandlers,
  createLoopHandler,
  type MiddlewareChunk,
} from "./middleware/index";
import type { LLMResponse } from "@/core/message/adapter";
import config from "@/utils/config";
import buildFirstSystemPrompt from "@/agent/prompt/index";
import type { SkillFilter } from "@/agent/prompt/loadSkill";
import { randomUUID } from "crypto";
import { RuntimeResolver, type RuntimeSelection } from "./runtimeResolver.js";

/**
 * AgentBuilder - RuntimeConfig 工厂 + Middleware 工厂
 *
 * 解耦后职责：
 * - 创建单 chat Middleware 实例
 * - 原子解析 brain + senseGroups 为 RuntimeConfig
 * - 通过 Middleware.configureRuntime 一次性注入运行时
 */
export class AgentBuilder {
  /** 构建的 AgentSession 实例（build 后持有，门面方法转发） */
  private agent?: AgentSession<MiddlewareChunk>;
  private readonly runtimeResolver = new RuntimeResolver();

  /**
   * 创建空 Middleware 实例（service 层每 chat 一个，跨轮不重建）
   * 构造只注入跨轮不变项：global + handlers + loopHandler
   */
  build(): this {
    this.agent = new AgentSession<MiddlewareChunk>(
      config.global,
      defaultHandlers,
      createLoopHandler(config.global.maxLoopCount),
    );
    return this;
  }

  /**
   * 原子配置 brain + senseGroups，避免 provider 与工具定义处于半配置状态。
   * @param injectMemoryManage 主 agent 硬编码注入 memory_manage（默认 true）；子 agent 传 false
   */
  configureRuntime(selection: RuntimeSelection, injectMemoryManage = true): this {
    const runtime = this.runtimeResolver.resolve(selection, { injectMemoryManage });
    this.requireAgent().configureRuntime(runtime);
    return this;
  }

  /**
   * 门面：初始化 chat（绑定 chatId，注入历史或 system 消息）
   * @param promptPathOverride 可选，per-subagent / 预设 main 专属 system prompt 路径（透传 buildFirstSystemPrompt）
   *
   * persona 修复：observer 不持久化 system 消息 → 重启后 loadHistory 返回 messages 无 system 首条。
   * 故统一保证内存 messages 首条为 system：历史存在但首条非 system → prepend；首条已是 system → 原样；无历史 → [systemMsg]。
   */
  init(chatId: string, messages?: LLMResponse[], promptPathOverride?: string, workspace?: string, skillFilter?: SkillFilter): this {
    const systemMsg = this.createInitialMessages(promptPathOverride, workspace, skillFilter);
    let msgs: LLMResponse[];
    if (messages && messages.length > 0) {
      // DB 不持久化基础系统提示词；压缩恢复会带一条系统摘要，因此始终先注入当前基础系统提示词。
      msgs = [...systemMsg, ...messages];
    } else {
      msgs = systemMsg;
    }
    this.requireAgent().init(chatId, msgs);
    return this;
  }

  private createInitialMessages(promptPathOverride?: string, workspace?: string, skillFilter?: SkillFilter): LLMResponse[] {
    const now = Date.now();
    return [
      {
        id: randomUUID(),
        role: "system",
        content: buildFirstSystemPrompt(promptPathOverride, workspace, skillFilter),
        createdAt: now,
        updateAt: now,
      },
    ];
  }

  /**
   * 门面：发送消息，返回 chunk generator（透传 AgentSession.send）
   * @param options.extraUserMessages 命令正文作为独立 user message 入队（详见 AgentSession.send）
   */
  run(
    input: string,
    options?: { extraUserMessages?: string[] },
  ): AsyncGenerator<MiddlewareChunk, void, unknown> {
    return this.requireAgent().send(input, options);
  }

  /**
   * 门面：续接（chat.resume，无 prompt）。
   * Case1（末尾有 pending sense）→ 置 resumePending 标志，首轮 skip chat 层恢复执行；
   * Case2（全 done）→ 不置标志，run("") 正常 loop（LLM 基于 done sense 回复）。
   */
  resume(): AsyncGenerator<MiddlewareChunk, void, unknown> {
    const agent = this.requireAgent();
    if (agent.hasPendingTrailingSense()) {
      agent.setResumePending(true);
    }
    return this.run("");
  }

  /**
   * 门面：撤回末尾整个当前周期 AI 响应（chat.send 恢复场景）
   */
  revokeTrailingCycle(): string[] {
    return this.requireAgent().revokeTrailingCycle();
  }

  /**
   * 门面：是否有活跃会话迭代器（service 判断 send 恢复撤回仅在 idle 时触发）
   */
  isRunning(): boolean {
    return this.requireAgent().isRunning();
  }

  /**
   * 门面：暴露内存消息列表（observer abort flush 用）
   */
  getMessages(): LLMResponse[] {
    return this.requireAgent().getMessages();
  }

  /**
   * 门面：注入角色回复消息（wait=true 子完成唤醒主用，见 docs/agent-pet.md §5.4）。
   * 守单一写者：经 journal.appendRoleReply 写 soul.messages（内存）；DB 落库由 service wakeParent addMessage。
   * @returns 新消息 id（供 wakeParent addMessage 落库）
   */
  appendRoleReply(content: string): string {
    return this.requireAgent().appendRoleReply(content);
  }

  /**
   * 门面：原地更新指定 sense 消息 content（ask_user_question yield-turn 占位→用户答案）。
   * 守单一写者：经 journal.completeSense 写 soul.messages（内存）；DB 答案由 question batch 事务先行落库。
   * @returns true=原地更新命中
   */
  completeSenseResult(senseId: string, content: string): boolean {
    return this.requireAgent().completeSenseResult(senseId, content);
  }

  /**
   * 门面：中止当前运行的 generator（chat.abort 场景）。
   * 转发 AgentSession.abort → compose.abort 注入错误退出 generator。
   */
  abort(): void {
    this.requireAgent().abort();
  }

  /**
   * 门面：senseTable 是否过期（registry 变更后未重建）。
   * send/resume 入口据此决定是否 re-configureRuntime（P1-6）。
   */
  isSenseTableStale(): boolean {
    return this.requireAgent().isSenseTableStale();
  }

  /**
   * 校验 agent 已构建（build 后才可配置/执行）
   */
  private requireAgent(): AgentSession<MiddlewareChunk> {
    if (!this.agent) {
      throw new Error("Agent 未构建，需先调用 build()");
    }
    return this.agent;
  }
}
