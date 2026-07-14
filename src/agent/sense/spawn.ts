import { z } from "zod";
import { randomUUID } from "crypto";
import { sense, type SenseResult, type SenseSharedData } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { hashGenerator } from "@/utils/hash.js"; // 仅复用条件 promptHash 仍用
import config from "@/utils/config.js";
import { createChat, findChatsByParent, getChatPreset, getChatSpawnTypes, getChatWorkspace, updateChatMetadata } from "@/db/chat.js";
import { emitRoleCreated, registerWaitedChild } from "@/agent/spawnBroker.js";
import { logger } from "@/utils/logger/index.js";
import { getSessionRoleRuntime, setEphemeralChatRuntime } from "@/service/chat/runtime.js";

// tool 暴露面：让主 agent LLM 可见可用角色及能力（非盲串 type）。
// - type 用 z.enum(roles 键) 硬约束（空配置兜底 z.string()，z.enum([]) 构造抛错）
// - catalog = config.roles 全集（单一源，模块加载期冻结；预设按 type 引用，不在预设内重定义）。
//   sense 定义不支持 per-chat 动态，故 catalog 为全局全集让 LLM 可见所有类型；
//   实际可 spawn 类型由执行期 roster gate 强制（preset chat 限选中集，见 resolveSpawnRoster）。
// - description 运行时拼接 catalog（每类型 brain(input: ...) + senseGroup），
//   input 维度从 brain config 动态读取（image/video/audio），主 agent 据此判断媒体委派目标。
const roleCatalog = new Map<string, { brain: string; senseGroup: string; inputCapabilities: string[] }>();
for (const [name, cfg] of Object.entries(config.roles ?? {})) {
  const brainCfg = config.llm.brain[cfg.brain];
  const inputCaps = Object.entries(brainCfg?.capabilities?.input ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  roleCatalog.set(name, { brain: cfg.brain, senseGroup: cfg.senseGroup, inputCapabilities: inputCaps });
}
const roleKeys = [...roleCatalog.keys()];
const typeSchema =
  roleKeys.length > 0
    ? z.enum(roleKeys as [string, ...string[]])
    : z.string();
const catalogText = roleKeys.length
  ? roleKeys
      .map((name) => {
        const c = roleCatalog.get(name);
        const inputStr = c?.inputCapabilities.length
          ? `(input: ${c.inputCapabilities.join("+")})`
          : "(input: none)";
        return `- ${name}: brain=${c?.brain}${inputStr}, senseGroup=${c?.senseGroup ?? ""}`;
      })
      .join("\n")
  : "（未配置任何角色）";
const spawnDescription = `派发角色执行子任务（异步并行 / 同步等待）。
可用角色类型（每类型能力 = brain + senseGroup）：
${catalogText}
必填参数：
- type: 角色类型名（上方枚举的可用键）
- prompt: 交付角色的任务描述
- wait: 是否需要角色结果
  - true: 主 agent 立即结束本轮（yield turn），子完成后结果自动注入唤起新一轮（适合需汇总子结果的任务）
  - false: 立即返回，主 agent 继续运行（fire-and-forget，子结果不回传）`;

/**
 * 解析 chat 可 spawn 的角色 type 集（roster gate，执行期强制）。
 * - preset chat：metadata.spawnTypes 快照（编制锁定，chat.create 写入）；旧主 chat 无快照 → live 回读 presets[preset].roles。
 * - 子 chat（无 preset）→ 全集 config.roles（递归：子也可 spawn 子）。
 * 注：spawn sense 的 type enum 为模块加载期冻结的全集 catalog（LLM 可见全部），roster 仅执行期 gate。
 */
function resolveSpawnRoster(chatId: string): string[] {
  const presetName = getChatPreset(chatId);
  if (!presetName) return roleKeys; // 子 chat → 全集可用
  const snap = getChatSpawnTypes(chatId);
  if (snap) return snap; // 新主 chat：创建快照（编制锁定；显式空集 = 不可 spawn）
  return config.presets?.[presetName]?.roles ?? roleKeys; // 旧主 chat：live 回读（无则全集兜底）
}

/**
 * spawn_role sense（主从 Agent 桌宠系统 CP3）
 *
 * 派发角色执行子任务。前端驱动架构（见 docs/agent-pet.md §2/§5.1/§5.4）：
 *   1. 后端创建子 chat 行（parent_chat_id 关联主 chat）+ 推 role_created notification
 *   2. 前端收 notification → 创建子 pet + 调 chat.send 跑子 agent（同 WS 连接按 chatId 路由 chunk）
 *   3. wait=true：registerWaitedChild + yieldTurn（主 loop 立即结束本 turn）；子完成后后端注入角色回复
 *      + 推 role_reply → 前端 chat.resume 唤主跑新一轮（B1 架构，不阻塞 sense）
 *      wait=false：立即返回，主 loop 继续（fire-and-forget，子结果不回传）
 *
 * 不在后端 sense 内部跑子 agent（规避 sense 无法 trigger chat.send、跨连接 busy 锁两大风险）。
 */
export default sense(
  "spawn_role",
  spawnDescription,
  z.object({
    type: typeSchema.describe("角色类型名（上方枚举的可用键）"),
    prompt: z.string().describe("交付角色执行的任务描述"),
    wait: z.boolean().default(false).describe("是否等待角色结果"),
  }),
  async (input, senseSharedData: SenseSharedData, ctx): Promise<SenseResult> => {
    // senseSharedData 在 spawn_role 中无业务用途（子 agent 独立 chat，不继承主 sense 共享状态）；
    // 保留参数为 sense() 工厂签名契约。void 显式标记"已用但为空实现"，避免 TS strict unused 检查告警。
    void senseSharedData;
    const { type, prompt, wait } = input;

    // ctx.chatId 是主 agent 当前 chatId（spawn 调用方）；缺省（异常调用场景）→ 抛错
    // 不静默兜底 chatId，避免子 chat 漂浮无 parent 溯源。先取 parentChatId 供预设解析。
    const parentChatId = ctx?.chatId;
    if (!parentChatId) {
      throw new Error(
        "spawn_role 缺少主 chatId（SenseRuntimeContext.chatId 未注入，无法关联主 agent）",
      );
    }

    // 1. 角色定义恒从 config.roles[type] 单一源解析（fail loud，规则12）。
    //    roster gate：preset chat 限 metadata.spawnTypes 选中集（未选中 → fail loud）；
    //    子 chat（无 preset）→ 全集可用（递归：子也可 spawn 子）。
    const roleCfg = config.roles?.[type];
    if (!roleCfg) {
      throw new Error(
        `角色类型 "${type}" 不在 config.roles（可用：${roleKeys.join(", ") || "（未配置任何角色）"}）`,
      );
    }
    const roster = resolveSpawnRoster(parentChatId);
    if (!roster.includes(type)) {
      const presetName = getChatPreset(parentChatId);
      throw new Error(
        `角色类型 "${type}" 不在${presetName ? `预设 "${presetName}" 选中的角色集` : "可用角色集"}（选中：[${roster.join(", ")}]）`,
      );
    }
    const { brain: defaultBrain, senseGroup: defaultSenseGroup, mcpServers: defaultMcpServers = [], systemPrompt: promptOverride } = roleCfg;
    const temporaryRuntime = getSessionRoleRuntime(parentChatId, type);
    const { brain, senseGroup } = temporaryRuntime ?? {
      brain: defaultBrain,
      senseGroup: defaultSenseGroup,
    };

    // 2. 创建子 chat 前,检查是否已有未完成的子 chat(避免重连/重发后重复创建)
    // 复用条件:type + prompt 都必相同(精确匹配)
    //   - parent_chat_id 匹配 + 未 finished(metadata.finished !== true)
    //   - type 相同:不同 type 是不同角色,不能复用(会污染子 agent 上下文)
    //   - promptHash 相同:不同 prompt 是不同任务(典型 fire-and-forget 多任务派发),即使 type 相同也不能复用
    //     —— 此前仅按 finished 匹配导致多任务全部挤到同一未完成子 chat,行为退化(见对话 90ecacf2)
    // 注:ChatRow 不含 type/prompt 字段,从 metadata 读(metadata.type / metadata.spawnPromptHash 在创建时写入)
    const inputPromptHash = hashGenerator("prompt", type, prompt);
    const existingChildren = findChatsByParent(parentChatId);
    const reusableChild = existingChildren.find(c => {
      const metadata = c.metadata ? JSON.parse(c.metadata) : {};
      return metadata.finished !== true
        && metadata.type === type
        && metadata.spawnPromptHash === inputPromptHash;
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
      // 也无需 runtime.set。后端已有 roles[type].brain+senseGroups,预创建时一次配齐契约最简。
      // mcpServers 缺省 [](子 agent 默认不开 MCP,与主 agent 解耦)。
      childChatId = randomUUID();
      // systemPrompt（per-role 专属 system prompt，绝对路径，来自 config.roles[type].systemPrompt 单一源；
      //   预设仅按 type 引用，无 per-preset 角色 systemPrompt 覆盖——故同一 type 的 persona 在所有引用它的预设生效；
      //   缺省 → undefined → 子 agent 用全局 system_prompt）。ensureChat 读 metadata.promptPathOverride 注入。
      // 子 agent 继承主 chat workspace（同项目，system prompt 注入同一工作区说明）
      const parentWorkspace = getChatWorkspace(parentChatId);
      createChat(
        childChatId,
        {
          // 持久化角色默认值；临时覆盖由下方 ephemeral runtime 接管，绝不写 DB。
          runtime: { brain: defaultBrain, senseGroup: defaultSenseGroup, mcpServers: defaultMcpServers },
          ...(promptOverride ? { promptPathOverride: promptOverride } : {}),
          ...(parentWorkspace ? { workspace: parentWorkspace } : {}),
          // T9.10 重启容错：wait+type 持久化，rebuildFromDb 扫 metadata.wait===true 重建唤醒链
          wait,
          type,
          // spawn 复用条件：type + spawnPromptHash 精确匹配（见上方 existingChildren.find）
          spawnPromptHash: inputPromptHash,
        },
        parentChatId,
      );
      // 记录完整 spawn 参数（创建新子chat时）
      logger.event("spawn.call", {
        parentChatId,
        childChatId,
        type,
        prompt: input.prompt,
        wait,
        brain,
        senseGroup,
        temporaryRuntime: !!temporaryRuntime,
      });
    }

    // 新建与复用子角色都使用当前会话的内存覆盖；不触碰其持久化默认编制。
    if (temporaryRuntime) setEphemeralChatRuntime(childChatId, temporaryRuntime);

    // 回写触发本次 spawn 的 sense call id 到子 chat metadata。
    // 新建分支：写入新 metadata 备用 + role_created 通知 + role_reply 唤醒时回读。
    // 复用分支：覆盖旧子 chat metadata（旧子可能存了上一轮 spawn id；用户断连重发触发同一子时新 id 应刷新）。
    // ctx?.messageId 缺省时（如外部/未注入 messageId 的 sense）→ undefined → 不写 key，前端兜底。
    const spawnSenseCallId = ctx?.messageId;
    if (spawnSenseCallId) {
      updateChatMetadata(childChatId, { spawnSenseCallId });
    }

    // 3. 推 role_created notification(spawnBroker.broadcaster → 主 chat 所属连接 ws)
    emitRoleCreated({
      chatId: childChatId,
      parentChatId,
      type,
      prompt,
      brain,
      senseGroup,
      wait,
      spawnSenseCallId,
    });

    // 4. wait=true:注册唤醒链 + yieldTurn（主 loop 本轮后立即结束 turn）+ 立即返回（不再阻塞 await）
    //    子完成后后端注入角色回复唤主跑新一轮（见 docs/agent-pet.md §5.4 B1）
    if (wait) {
      registerWaitedChild(childChatId, parentChatId, type);
      ctx?.yieldTurn?.();
      // 不返回 hash：spawn 的"派发标识" hash 命中 ≠ 重复派发任务（实际可能是"不同任务复用未完成子 chat"），
      //   会导致 tool.ts replaceSense 错误折叠 sense 消息、丢失原始 prompt 参数（见对话 90ecacf2）。
      return {
        content: `角色 "${type}" 已派发（chatId=${childChatId}），等待结果中。`,
      };
    }

    // wait=false：立即返回，主 loop 继续（纯 fire-and-forget，子结果不回传主）
    return {
      content: `角色 "${type}" 已派发（chatId=${childChatId}），不等待结果。`,
    };
  },
  SupervisionLevel.auto,
);
