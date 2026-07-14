/**
 * memory_manage sense — 项目记忆管理工具。
 *
 * 硬编码注入主 agent（RuntimeResolver），子 agent 排除。
 * 操作：add / remove / update / list / history。
 * 存储路径由 chat workspace 决定（getChatWorkspace(ctx.chatId)）。
 */

import { z } from "zod";
import { sense, type SenseResult, type SenseSharedData } from "@/core/sense";
import { SupervisionLevel } from "@/core/config";
import { hashGenerator } from "@/utils/hash.js";
import { getChatWorkspace } from "@/db/chat.js";
import { addMemory, removeMemory, updateMemory, listMemories, listHistories } from "@/memory/index.js";
import type { MemoryType } from "@/memory/index.js";

const MemoryAction = z.enum(["add", "remove", "update", "list", "history"]);
const MemoryTypeSchema = z.enum(["feedback", "fact", "instruction", "decision", "reference"]);

const MemoryManageSchema = z.object({
  action: MemoryAction.describe("操作类型"),
  /** add/update/remove 时必填 */
  name: z.string().optional().describe("记忆标识名（kebab-case）"),
  /** add 时必填；update 可选 */
  description: z.string().optional().describe("一句话描述（≤100字）"),
  /** add/update 时必填 */
  content: z.string().optional().describe("记忆正文（markdown）"),
  /** add 时必填 */
  type: MemoryTypeSchema.optional().describe("分类：feedback/fact/instruction/decision/reference"),
  /** add 且达上限时必填 */
  replaceTarget: z.string().optional().describe("淘汰目标记忆名（活跃记忆达上限时必填）"),
  /** add 且达上限时必填 */
  replaceReason: z.string().optional().describe("淘汰原因"),
  /** remove 时可选（缺省 → "用户主动删除"） */
  reason: z.string().optional().describe("删除原因"),
});

/** 格式化记忆列表为可读文本 */
function formatMemoryList(items: { name: string; description: string; type: string }[]): string {
  if (items.length === 0) return "（空）";
  return items.map((m, i) => `${i + 1}. [${m.type}] ${m.name} — ${m.description}`).join("\n");
}

async function handler(
  input: z.infer<typeof MemoryManageSchema>,
  _sharedData: SenseSharedData,
  ctx?: { chatId: string },
): Promise<SenseResult> {
  const { action, name, description, content, type, replaceTarget, replaceReason, reason } = input;
  const workspace = ctx?.chatId ? getChatWorkspace(ctx.chatId) : undefined;

  switch (action) {
    case "add": {
      if (!name || !description || !content || !type) {
        return { content: "错误：add 操作需要 name、description、content、type 参数", hash: hashGenerator("memory", "add-error") };
      }
      const result = addMemory({
        name, description, content, type: type as MemoryType, replaceTarget, replaceReason, workspace,
      });
      if (!result.ok) return { content: `添加失败：${result.error}`, hash: hashGenerator("memory", `add-fail-${name}`) };
      const evicted = result.evicted ? `\n已淘汰：${result.evicted}` : "";
      return { content: `记忆 '${name}' 已添加。${evicted}`, hash: hashGenerator("memory", `add-${name}`) };
    }

    case "remove": {
      if (!name) return { content: "错误：remove 操作需要 name 参数", hash: hashGenerator("memory", "remove-error") };
      const result = removeMemory(name, reason ?? "", workspace);
      if (!result.ok) return { content: `删除失败：${result.error}`, hash: hashGenerator("memory", `remove-fail-${name}`) };
      return { content: `记忆 '${name}' 已删除（移入历史）。`, hash: hashGenerator("memory", `remove-${name}`) };
    }

    case "update": {
      if (!name) return { content: "错误：update 操作需要 name 参数", hash: hashGenerator("memory", "update-error") };
      const result = updateMemory({ name, content, description, workspace });
      if (!result.ok) return { content: `更新失败：${result.error}`, hash: hashGenerator("memory", `update-fail-${name}`) };
      return { content: `记忆 '${name}' 已更新。`, hash: hashGenerator("memory", `update-${name}`) };
    }

    case "list": {
      const memories = listMemories(workspace);
      const formatted = formatMemoryList(memories);
      return {
        content: `活跃记忆（${memories.length} 条）：\n${formatted}`,
        hash: hashGenerator("memory", `list-${memories.length}`),
      };
    }

    case "history": {
      const entries = listHistories(workspace);
      const formatted = entries.length === 0
        ? "（空）"
        : entries.map((e, i) =>
          `${i + 1}. [${e.type}] ${e.name} — ${e.description}\n   被 '${e.replacedBy}' 替换于 ${e.replacedAt}（${e.replacedReason}）`,
        ).join("\n");
      return {
        content: `历史记忆（${entries.length} 条）：\n${formatted}`,
        hash: hashGenerator("memory", `history-${entries.length}`),
      };
    }
  }
}

export default sense(
  "memory_manage",
  `管理项目记忆（Markdown 文件存储，用户可手动维护）。

记忆用于持久化项目重要决策、约定、反馈等上下文信息，跨会话保留。
每条记忆有 name（kebab-case 标识）、description（一句话描述）、type（分类）、content（正文）。

活跃记忆上限由配置决定（默认 15 条），达上限时 add 必须指定 replaceTarget + replaceReason 淘汰旧记忆。
淘汰的记忆移入历史（history），记录替换时间、原因、被谁替换。

操作说明：
- add：添加新记忆（name/description/content/type 必填；达上限时 replaceTarget/replaceReason 必填）
- remove：删除记忆（移入历史）
- update：更新已有记忆的内容或描述
- list：列出所有活跃记忆
- history：列出所有历史记忆（含替换元数据）

分类说明：
- feedback：用户反馈/偏好（如"用户喜欢简洁回复"）
- fact：项目事实（如"数据库用 SQLite"）
- instruction：操作准则（如"修改前先改文档"）
- decision：架构决策（如"选择方案A因为..."）
- reference：外部参考（如"API文档地址"）`,
  MemoryManageSchema,
  handler,
  SupervisionLevel.auto,
);
