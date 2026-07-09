import { z } from "zod";
import { randomUUID } from "crypto";
import { sense, type SenseResult, type SenseSharedData } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { hashGenerator } from "@/utils/hash.js";
import config from "@/utils/config.js";
import { createChat, findChatsByParent } from "@/db/chat.js";
import { emitSubagentCreated, registerHeartbeatListener } from "@/agent/spawnBroker.js";
import { logger } from "@/utils/logger/index.js";

// tool 暴露面：让主 agent LLM 可见可用子 agent 及能力（非盲串 type）。
// - type 用 z.enum(可用键) 硬约束（空配置兜底 z.string()，z.enum([]) 构造抛错）
// - description 运行时拼接 config.subagents catalog（每类型 brain + senseGroups），
//   senseGroups 显组名不展开（组名即"能力体现"，见 docs/agent-pet.md §2）
// - 模块加载期由 config 单例构建（本项目无热重载，启动期冻结可接受）
const subagentEntries = Object.entries(config.subagents ?? {});
const subagentKeys = subagentEntries.map(([name]) => name);
const typeSchema =
  subagentKeys.length > 0
    ? z.enum(subagentKeys as [string, ...string[]])
    : z.string();
const catalogText = subagentEntries.length
  ? subagentEntries
      .map(
        ([name, cfg]) =>
          `- ${name}: brain=${cfg.brain}, senseGroups=[${cfg.senseGroups.join(", ")}]`,
      )
      .join("\n")
  : "（未配置任何 subagent）";
const spawnDescription = `派发子 agent 执行子任务（异步并行 / 同步等待）。
可用子 agent 类型（每类型能力 = brain + senseGroups）：
${catalogText}
必填参数：
- type: 子 agent 类型名（上方枚举的可用键）
- prompt: 交付子 agent 的任务描述
- wait: 是否等待子 agent 结果回传
  - true: 阻塞当前主 agent，直到子 agent 执行完毕结果回传
  - false: 立即返回，主 agent 继续运行（fire-and-forget）`;

/**
 * spawn_subagent sense（主从 Agent 桌宠系统 CP3）
 *
 * 派发子 agent 执行子任务。前端驱动架构（见 docs/agent-pet.md §2/§5.1）：
 *   1. 后端创建子 chat 行（parent_chat_id 关联主 chat）+ 推 subagent_created notification
 *   2. 前端收 notification → 创建子 pet + 调 chat.create/chat.send 跑子 agent（同 WS 连接按 chatId 路由 chunk）
 *   3. wait=true：sense 挂起等前端 subagent.result(childChatId, content) 回传 → 返回子 agent content
 *      wait=false：sense 立即返回，前端跑完后自行注入主 chat（chat.send 角色扮演）
 *
 * 不在后端 sense 内部跑子 agent（规避 sense 无法 trigger chat.send、跨连接 busy 锁两大风险）。
 */
export default sense(
  "spawn_subagent",
  spawnDescription,
  z.object({
    type: typeSchema.describe("子 agent 类型名（上方枚举的可用键）"),
    prompt: z.string().describe("交付子 agent 执行的任务描述"),
    wait: z.boolean().default(false).describe("是否等待子 agent 结果"),
  }),
  async (input, _senseSharedData: SenseSharedData, ctx): Promise<SenseResult> => {
    const { type, prompt, wait } = input;

    // 1. 解析子 agent 配置（fail loud，规则12）
    const subagentCfg = config.subagents?.[type];
    if (!subagentCfg) {
      throw new Error(
        `子 agent 类型 "${type}" 不在 config.subagents 列表（可用：${Object.keys(config.subagents ?? {}).join(", ") || "（未配置任何 subagent）"}）`,
      );
    }
    const { brain, senseGroups } = subagentCfg;

    // ctx.chatId 是主 agent 当前 chatId（spawn 调用方）；缺省（异常调用场景）→ 抛错
    // 不静默兜底 chatId，避免子 chat 漂浮无 parent 溯源。
    const parentChatId = ctx?.chatId;
    if (!parentChatId) {
      throw new Error(
        "spawn_subagent 缺少主 chatId（SenseRuntimeContext.chatId 未注入，无法关联主 agent）",
      );
    }

    // 2. 创建子 chat 前,检查是否已有未完成的子 chat(避免重连/重发后重复创建)
    // 复用条件:parent_chat_id 匹配 + 未 finished(metadata.finished !== true)
    // 注:ChatRow 不含 type/prompt 字段(存在主 chat sense_calls 里),无法精确匹配类型
    // 简化策略:同 parent 下有未完成子 chat 即复用(主 agent 通常 wait=true 串行派发,不会并发多类型)
    const existingChildren = findChatsByParent(parentChatId);
    const reusableChild = existingChildren.find(c => {
      const metadata = c.metadata ? JSON.parse(c.metadata) : {};
      return metadata.finished !== true;
    });

    let childChatId: string;
    if (reusableChild) {
      // 复用未完成子 chat(断连恢复场景)
      childChatId = reusableChild.id;
      logger.event("spawn.reuse", { parentChatId, childChatId, type });
    } else {
      // 创建新子 chat 行 + 预配 runtime(metadata.runtime 路径同 chat.create handler)
      // 前端收 notification 后直接 chat.send(childChatId, prompt):ensureChat 检测 metadata.runtime
      // 已存在 → 自动恢复(getChatRuntimeSelection),无需前端再 chat.create(避 PRIMARY KEY 冲突)
      // 也无需 runtime.set。后端已有 subagents[type].brain+senseGroups,预创建时一次配齐契约最简。
      // mcpServers 缺省 [](子 agent 默认不开 MCP,与主 agent 解耦)。
      childChatId = randomUUID();
      createChat(
        childChatId,
        { runtime: { brain, senseGroups, mcpServers: [] } },
        parentChatId,
      );
    }

    // 3. 推 subagent_created notification(spawnBroker.broadcaster → 主 chat 所属连接 ws)
    emitSubagentCreated({
      chatId: childChatId,
      parentChatId,
      type,
      prompt,
      brain,
      senseGroups,
      wait,
    });

    // 4. wait=true:挂起等子 agent 心跳通知(finished 心跳带结果,30s 超时)
    // 子 agent 每 5s 发 running 心跳,主收到则重置超时;finished 心跳 resolve;error 心跳 reject
    if (wait) {
      const content = await registerHeartbeatListener(childChatId);
      const hash = hashGenerator("spawn_subagent", childChatId, type, content);
      return { content, hash };
    }

    // wait=false：立即返回，主 agent 不阻塞
    const hash = hashGenerator("spawn_subagent", childChatId, type, "fire-and-forget");
    return {
      content: `子 agent "${type}" 已派发（chatId=${childChatId}），不等待结果。`,
      hash,
    };
  },
  SupervisionLevel.auto,
);
