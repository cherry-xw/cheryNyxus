/**
 * 集成式 agent 测试 harness：装配真实 AgentBuilder 跑洋葱链。
 *
 * 复用全局 setupFiles（vite.config test.setupFiles = test/flows/setup.ts）已设
 * CHERY_DIR = test/flows/fixtures，故 config.yaml（mock brain + sense_groups）已就绪，
 * bootstrapAgentRuntime 注册 mock provider + 内置 senses（bash/read/write/skill）。
 *
 * 与 flows/ WS 端到端测试不同：此处不走 service/WS/DB，直接在 middleware 层跑，
 * 断言洋葱链 yield 的 MiddlewareChunk 序列（checkpoint/sense/retry/chat/loop 行为）。
 */
import { randomUUID } from "crypto";
import { AgentBuilder } from "@/agent/builder.js";
import { bootstrapAgentRuntime } from "@/agent/bootstrap.js";
import { resolveApproval, rejectApproval } from "@/core/sense/index.js";
import { AgentAbortError } from "@/core/middleware/errors.js";
import type { MiddlewareChunk, SensePendingChunk } from "@/core/middleware/types.js";
import type { LLMResponse } from "@/core/message/adapter.js";
import { collectChunks } from "./chunkAssert.js";

export type ApprovalAction = "accept" | "reject";

/** 审批决策回调：收到 sense_pending 时返回如何处置 */
export type ApprovalDecider = (
  pending: SensePendingChunk,
) => ApprovalAction | { action: ApprovalAction; reason?: string } | undefined;

let bootstrapped = false;

/**
 * 注册 provider + 内置 senses（幂等）。
 * vitest forks pool 每文件独立进程，故每文件 beforeAll 各自 bootstrap。
 */
export async function bootstrapForTests(): Promise<void> {
  if (bootstrapped) return;
  await bootstrapAgentRuntime();
  bootstrapped = true;
}

export interface CreateAgentOptions {
  /** brain 名（flows/fixtures config.yaml 中的 mock brain，如 mock_content/mock_auto） */
  brain: string;
  /** 感官组名（auto_senses/confirm_senses/mixed_confirm） */
  senseGroups: string[];
  /** chatId（缺省随机） */
  chatId?: string;
  /** 初始历史消息（缺省由 builder 注入 system prompt） */
  history?: LLMResponse[];
}

/**
 * 构建并初始化 agent：build → configureRuntime → init。
 * 返回的 agent 可直接 .run() / .resume() / .revokeTrailingCycle() 等。
 */
export function createAgent(opts: CreateAgentOptions): AgentBuilder {
  const agent = new AgentBuilder()
    .build()
    .configureRuntime({ brain: opts.brain, senseGroups: opts.senseGroups, mcpServers: [] });
  agent.init(opts.chatId ?? randomUUID(), opts.history);
  return agent;
}

/**
 * 跑 send 并收集全部 chunk。
 * 含 confirm/manual sense 时会阻塞在 await approval —— 用 runSendWithApproval。
 */
export async function runSend(
  agent: AgentBuilder,
  prompt: string,
): Promise<MiddlewareChunk[]> {
  return collectChunks(agent.run(prompt));
}

/**
 * 跑 send，边收集边处理审批。
 * decide 收到每个 sense_pending 返回处置；返回 undefined 表示不处理（留给调用方后续手动 resolve）。
 */
export async function runSendWithApproval(
  agent: AgentBuilder,
  prompt: string,
  decide: ApprovalDecider,
): Promise<MiddlewareChunk[]> {
  const out: MiddlewareChunk[] = [];
  for await (const c of agent.run(prompt)) {
    out.push(c);
    if (c.type === "sense_pending") {
      const pending = c as SensePendingChunk;
      const decision = decide(pending);
      if (decision) {
        if (typeof decision === "string") {
          resolveApproval(pending.approvalId, decision);
        } else {
          resolveApproval(pending.approvalId, decision.action, decision.reason);
        }
      }
    }
  }
  return out;
}

/** 便捷：所有审批统一 accept */
export function runSendAcceptAll(
  agent: AgentBuilder,
  prompt: string,
  reason?: string,
): Promise<MiddlewareChunk[]> {
  return runSendWithApproval(agent, prompt, () =>
    reason ? { action: "accept", reason } : "accept",
  );
}

/** 便捷：所有审批统一 reject */
export function runSendRejectAll(
  agent: AgentBuilder,
  prompt: string,
  reason?: string,
): Promise<MiddlewareChunk[]> {
  return runSendWithApproval(agent, prompt, () =>
    reason ? { action: "reject", reason } : "reject",
  );
}

/** 跑 resume（续接）并收集全部 chunk */
export async function runResume(agent: AgentBuilder): Promise<MiddlewareChunk[]> {
  return collectChunks(agent.resume());
}

/** 手动 resolve 某个 pending（用于精细控制审批时序） */
export function approve(approvalId: string, action: ApprovalAction, reason?: string): void {
  resolveApproval(approvalId, action, reason);
}

/** 手动 reject（abort）某个 pending */
export function abortApproval(approvalId: string, error?: Error): void {
  rejectApproval(approvalId, error ?? new AgentAbortError());
}
