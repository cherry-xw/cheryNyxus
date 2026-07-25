/**
 * memory_manage sense — 项目记忆管理工具（双层 · 平铺布局）。
 *
 * 硬编码注入主 agent（RuntimeResolver），子 agent 排除。
 * 操作：add / remove / update / list / history。
 * 必填参数 scope 决定作用域：
 *   - scope="global"    → .chery/memory/                            （无视 chat workspace）
 *   - scope="workspace" → .chery/workspace/<hash>/memory/           （要求 chat 已配置 PresetConfig.workspace）
 *                       未配置 workspace 的 chat 调用 scope="workspace" 会返回错误，提示改用 scope="global"
 */

import { z } from 'zod'
import { sense, type SenseResult, type SenseSharedData } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { hashGenerator } from '@/utils/hash.js'
import { getChatWorkspace } from '@/db/chat.js'
import {
  addMemory,
  removeMemory,
  updateMemory,
  listMemories,
  listHistories,
  type MemoryType,
  type MemoryScope,
} from '@/memory/index.js'

const MemoryAction = z.enum(['add', 'remove', 'update', 'list', 'history'])
const MemoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference'])
const MemoryScopeSchema = z.enum(['global', 'workspace'])

const MemoryManageSchema = z.object({
  action: MemoryAction.describe('操作类型'),
  /** 必填：选择记忆作用域。两层独立、互相不干扰。AI 显式选择写入/读取哪一层。 */
  scope: MemoryScopeSchema.describe(
    '作用域：global（跨 chat 共享）/ workspace（per 项目；要求 chat 已配置 workspace）',
  ),
  /** add/update/remove 时必填 */
  name: z.string().optional().describe('记忆标识名（kebab-case）'),
  /** add 时必填；update 可选 */
  description: z.string().optional().describe('一句话描述（≤100字）'),
  /** add/update 时必填 */
  content: z
    .string()
    .optional()
    .describe('记忆正文（markdown；feedback/project 类必须含 Why + How to apply 结构）'),
  /** add 时必填 */
  type: MemoryTypeSchema.optional().describe('分类：user/feedback/project/reference'),
  /** add 且达该层上限时必填 */
  replaceTarget: z.string().optional().describe('淘汰目标记忆名（该层活跃记忆达上限时必填）'),
  /** add 且达该层上限时必填 */
  replaceReason: z.string().optional().describe('淘汰原因'),
  /** remove 时可选（缺省 → "用户主动删除"） */
  reason: z.string().optional().describe('删除原因'),
})

/** 格式化记忆列表为可读文本 */
function formatMemoryList(items: { name: string; description: string; type: string }[]): string {
  if (items.length === 0) return '（空）'
  return items.map((m, i) => `${i + 1}. [${m.type}] ${m.name} — ${m.description}`).join('\n')
}

async function handler(
  input: z.infer<typeof MemoryManageSchema>,
  _sharedData: SenseSharedData,
  ctx?: { chatId: string },
): Promise<SenseResult> {
  const { action, scope, name, description, content, type, replaceTarget, replaceReason, reason } =
    input
  // 解析 chat workspace：scope=global 强制 undefined；scope=workspace 必须有值，否则报错
  const chatWorkspace =
    scope === 'global' ? undefined : ctx?.chatId ? getChatWorkspace(ctx.chatId) : undefined
  if (scope === 'workspace' && !chatWorkspace) {
    return {
      content:
        '错误：当前 chat 未配置 PresetConfig.workspace，无法使用 scope="workspace"。请改用 scope="global"。',
      hash: hashGenerator('memory', 'no-workspace'),
    }
  }
  const workspace = chatWorkspace // 已校验非 undefined（当 scope=workspace 时）
  const memoryScope: MemoryScope = scope

  switch (action) {
    case 'add': {
      if (!name || !description || !content || !type) {
        return {
          content: '错误：add 操作需要 name、description、content、type 参数',
          hash: hashGenerator('memory', 'add-error'),
        }
      }
      const result = addMemory({
        name,
        description,
        content,
        type: type as MemoryType,
        replaceTarget,
        replaceReason,
        workspace,
        scope: memoryScope,
      })
      if (!result.ok)
        return {
          content: `添加失败：${result.error}`,
          hash: hashGenerator('memory', `add-fail-${name}`),
        }
      const evicted = result.evicted ? `\n已淘汰：${result.evicted}` : ''
      return {
        content: `记忆 '${name}' 已添加（${scope} 层）。${evicted}`,
        hash: hashGenerator('memory', `add-${name}`),
      }
    }

    case 'remove': {
      if (!name)
        return {
          content: '错误：remove 操作需要 name 参数',
          hash: hashGenerator('memory', 'remove-error'),
        }
      const result = removeMemory(name, reason ?? '', workspace, memoryScope)
      if (!result.ok)
        return {
          content: `删除失败：${result.error}`,
          hash: hashGenerator('memory', `remove-fail-${name}`),
        }
      return {
        content: `记忆 '${name}' 已删除（${scope} 层，移入历史）。`,
        hash: hashGenerator('memory', `remove-${name}`),
      }
    }

    case 'update': {
      if (!name)
        return {
          content: '错误：update 操作需要 name 参数',
          hash: hashGenerator('memory', 'update-error'),
        }
      const result = updateMemory({ name, content, description, workspace, scope: memoryScope })
      if (!result.ok)
        return {
          content: `更新失败：${result.error}`,
          hash: hashGenerator('memory', `update-fail-${name}`),
        }
      return {
        content: `记忆 '${name}' 已更新（${scope} 层）。`,
        hash: hashGenerator('memory', `update-${name}`),
      }
    }

    case 'list': {
      const memories = listMemories(workspace, memoryScope)
      const formatted = formatMemoryList(memories)
      return {
        content: `${scope} 层活跃记忆（${memories.length} 条）：\n${formatted}`,
        hash: hashGenerator('memory', `list-${scope}-${memories.length}`),
      }
    }

    case 'history': {
      const entries = listHistories(workspace, memoryScope)
      const formatted =
        entries.length === 0
          ? '（空）'
          : entries
              .map(
                (e, i) =>
                  `${i + 1}. [${e.type}] ${e.name} — ${e.description}\n   被 '${e.replacedBy}' 替换于 ${e.replacedAt}（${e.replacedReason}）`,
              )
              .join('\n')
      return {
        content: `${scope} 层历史记忆（${entries.length} 条）：\n${formatted}`,
        hash: hashGenerator('memory', `history-${scope}-${entries.length}`),
      }
    }
  }
}

export default sense(
  'memory_manage',
  `管理项目记忆（Markdown 文件存储，用户可手动维护）。

记忆分两层独立管理，AI 必须显式指定 scope 选择写入层：

- **scope="global"**（全局层，跨 chat 共享；所有 chat 自动加载）：
  - 路径 .chery/memory/
  - 结构 main.md（活跃索引） + *.md（活跃条目，平铺） + history/ 目录（淘汰归档）
  - 默认上限 30 条 / 单条 500 字（取自 config.memory.global）
  - 适用：用户的角色/偏好、通用准则
  - 分类参考：user（用户角色/目标/专业水平）/ feedback（用户对工作方式的纠正+认可）

- **scope="workspace"**（项目层，per 项目；PresetConfig.workspace 已配置时才可用）：
  - 路径 .chery/workspace/<hash>/memory/
  - 结构同 global（main.md + 平铺 *.md + history/）
  - 默认上限 15 条 / 单条 500 字（取自 config.memory.workspace）
  - 适用：项目级约束、架构决策、外部参考
  - 分类参考：project（项目进展/决策/截止日期）/ reference（外部系统指针）

⚠️ **调用前先确认 chat 是否配置了 workspace**：通过 system prompt 中的 <workspace> 段判断；若无 <workspace> 段则该 chat 只能用 scope="global"，用 scope="workspace" 会返回错误。

每条记忆有 name（kebab-case 标识）、description（一句话描述）、type（分类）、content（正文）。

**四种类型（闭合分类，必须归入其一）**：
- user：用户角色、目标、专业水平、偏好。避免写可能被视为负面评价的内容
- feedback：用户对工作方式的反馈——既记纠正也记认可。content 结构：先规则，再 **Why:** 行（原因/过往事件），再 **How to apply:** 行（何时/何地适用）
- project：项目不可从代码/git 推导的信息（谁做什么、为什么、截止日期）。content 结构同 feedback；**相对日期必须转绝对日期**（"周四"→"2026-07-25"）
- reference：外部系统指针（Linear 项目、Grafana 看板、Slack 频道等），记住"去哪找"而非信息本身

**保存约束（即使用户显式请求也拒绝）**：
- 不保存可推导信息（代码模式/架构/文件路径/git 历史/调试配方）——这些 read_file / git log 可查
- 不保存 CLAUDE.md 已有内容、当前对话临时任务状态（用 todo/plan 而非 memory）
- 用户要求保存 PR 列表/活动摘要时，只保存「令人意外或非显而易见」的部分

每层活跃上限独立计数；达上限时 add 必须指定 replaceTarget + replaceReason 淘汰旧记忆。
淘汰的记忆移入该层 history/，记录替换时间、原因、被谁替换。

**add 前先 list 检查已有 manifest**——有同主题记忆则 update 更新，而非创建重复文件。

操作说明：
- add：添加新记忆（name/description/content/type 必填；达上限时 replaceTarget/replaceReason 必填；feedback/project 类 content 必须含 Why + How to apply）
- remove：删除记忆（移入该层历史）
- update：更新已有记忆的内容或描述
- list：列出该层活跃记忆
- history：列出该层历史记忆（含替换元数据）`,
  MemoryManageSchema,
  handler,
  SupervisionLevel.auto,
)
