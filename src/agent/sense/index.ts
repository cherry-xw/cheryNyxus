import type { ZodType } from 'zod'
import type { Sense } from '@/core/sense'
import type { TestCase } from '@/core/sense/compiler/types.js'
import { registerSenses, resetSenses } from '@/core/sense'
import { readdirSync, existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { sense } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'

// 显式导入所有感官模块
import bashSense from './bash'
import readSense from './read'
import writeSense from './write'
import skillSense from './skill'
import searchSense from './search'
import historyRecallSense from './historyRecall'
import spawnSense from './spawn'
import todoSense from './todo'
import memorySense from './memory'
import mediaSenses from './media'
import askSense from './ask'
import installSkillSense from './installSkill'
import configManageSense from './configManage'
import childControlSenses from './childControl'
import selectConversationSense from './selectConversation'
import { logger } from '@/utils/logger/index.js'

/**
 * 内置工具元信息（供 sense.tools API 返回，设置面板感官分组下拉用）。
 * name=原名（作 sense_groups 条目 key，须与各 sense 模块 definition.function.name 一致）；
 * label=中文名（UI 显示）；description=一行简介（下拉/轻量 tooltip）；icon=glyph/emoji 字符串（pet bar 运行中工具图标用）。
 * doc=完整说明文档（sense.tools.docs API 数据源）：按【作用】【能力】【边界】【注意】分节，
 * 每行一个段落，前端 hover 悬浮按 pre-line 展示。sense.tools 只吐 name/label/description/icon，
 * 避免每个下拉都携带大段文档；doc 统一由 sense.tools.docs 按需（全量或按 name 列表）获取。
 */
export interface BuiltinSenseTool {
  name: string
  label: string
  description: string
  icon: string
  /** 完整说明文档：作用/能力/边界/注意点（换行分隔，前端 hover 展示）。新增工具时必须补。 */
  doc: string
}

/**
 * 代码维护的全部内置工具清单（sense.tools API 的数据源）。
 * 仅内置 sense；自定义/外部编译感官与 MCP 工具不在此列，前端组合框允许自由输入。
 * 新增内置 sense 时须同步追加此处（name 与模块一致）。icon 用 glyph/emoji（pet bar 运行中工具显示）。
 */
export const BUILTIN_SENSE_TOOLS: BuiltinSenseTool[] = [
  {
    name: 'execute_command',
    label: '执行命令',
    description: '执行 shell 命令，可跑任意终端指令（危险）',
    icon: '💻',
    doc:
      '【作用】在 shell 中执行命令（bash / powershell），是 Agent 操作文件系统、运行程序、查询系统状态的主要入口。\n' +
      '【能力】支持 bash / powershell 两种方言；可指定工作目录与超时；输出超长自动截断并保留日志路径；挂起进程可查询、可显式杀死。\n' +
      '【边界】仅限本机 shell 环境；命令受工作目录与 OS 沙箱约束（无有效工作区时 fail closed）；网络访问取决于宿主环境。\n' +
      '【注意】危险器官！可执行任意命令（含删除、格式化等破坏性操作）；配 :auto 等于放它自行执行不问你。读文件优先用 read_file，避免命令行读写。',
  },
  {
    name: 'read_file',
    label: '读取文件',
    description: '读文件内容，自动截断长文件与日志',
    icon: '📄',
    doc:
      '【作用】读取文件内容，供 Agent 理解代码、配置与日志。\n' +
      '【能力】支持绝对路径；可用 offset/limit 分段读取；大文件自动截断（仅显示前若干行）或按日志去重（drain）压缩；日志文件智能识别。\n' +
      '【边界】只读，不修改文件；路径必须是绝对路径；超长内容会被截断，需按返回提示用 offset 继续读取。\n' +
      '【注意】读取单个文件请优先使用本工具，而不是用 bash cat；截断时按提示分段续读。',
  },
  {
    name: 'write_file',
    label: '写入文件',
    description: '创建或编辑文件（危险）',
    icon: '✏️',
    doc:
      '【作用】创建新文件或编辑已有文件，是 Agent 写代码、改配置的主要入口。\n' +
      '【能力】全量写入覆盖；支持 offset+limit 行范围替换、插入（limit=0）与末尾追加，适合大文件局部编辑。\n' +
      '【边界】只能写指定文件路径；大文件局部编辑前必须先 read_file 拿准确行号。\n' +
      '【注意】危险器官！写代码/配置会改变运行结果与后续行为；配 :auto 前确认影响面。编辑前先读原文，避免覆盖丢失内容。',
  },
  {
    name: 'skill',
    label: '技能',
    description: '调用已注册的 Skill',
    icon: '⚡',
    doc:
      '【作用】激活一个已注册的技能，把该技能的完整指令注入当前上下文。\n' +
      '【能力】按技能名加载 SKILL.md 的说明与正文；用户问题命中技能描述时应优先调用。\n' +
      '【边界】只能调用已安装/注册的技能；同名技能不重复加载。\n' +
      '【注意】技能指令须像系统提示词一样严格遵守；每次激活都会增加上下文 token 开销，按需使用。',
  },
  {
    name: 'search_codebase',
    label: '搜索代码库',
    description: '按内容或文件名搜索代码',
    icon: '🔍',
    doc:
      '【作用】在指定目录内按文件内容或文件名搜索代码，定位实现与引用。\n' +
      '【能力】content 模式按文本内容搜索（grep）；filename 模式按文件名模糊搜索；限定搜索根目录。\n' +
      '【边界】必须提供绝对路径根目录，仅在该目录及子目录内搜索；依赖 fff 原生库（未安装时不可用）；首次索引扫描可能耗时。\n' +
      '【注意】扫描超时可能导致结果不完整；关键词过宽时结果多，先缩小目录或关键词。',
  },
  {
    name: 'history_recall',
    label: '历史回忆',
    description: '检索被压缩的长会话历史（代际目录 + 关键词搜索，只读）',
    icon: '🕰️',
    doc:
      '【作用】在长会话被压缩后，检索被归档的历史消息，找回早期细节。\n' +
      '【能力】list_generations 列出代际目录（含时间/节点数/摘要）；search 按关键词做大小写不敏感子串匹配，返回命中片段与上下文；可限定代序号、角色与条数上限。\n' +
      '【边界】只读；输出有硬字符上限（默认 4000，超限截断并注明）；仅覆盖已定稿的压缩代。\n' +
      '【注意】关键词为子串匹配，查不到时换更短/更精确的关键词或缩小代范围；重要信息应尽量在上下文中保留。',
  },
  {
    name: 'spawn_role',
    label: '派遣角色',
    description: '派出角色执行子任务',
    icon: '👥',
    doc:
      '【作用】派遣子 Agent（角色/pet）执行独立子任务，实现多线并行工作。\n' +
      '【能力】按 config.roles 中已配置的角色目录选择目标；携带任务内容，支持等待完成或异步派发；返回子任务进度与结果。\n' +
      '【边界】只能派遣已配置的角色；子任务在自己的会话与工作区中运行。\n' +
      '【注意】并行子任务可能同时读写工作区，注意文件冲突；派发会占用额外模型消耗，拆分任务要适度。',
  },
  {
    name: 'stop_child',
    label: '停止子角色',
    description: '停止指定子 Agent 或其子树',
    icon: '⏹️',
    doc:
      '【作用】停止当前主会话下指定的子 Agent，结束其任务执行。\n' +
      '【能力】按子 chatId 定位；recursive=true 时按孙到子的顺序停止整棵子树；重复调用使用稳定 command ID，不会重复写事实。\n' +
      '【边界】只能停止当前主会话下的子 Agent；已结束/已失败子 Agent 无需停止。\n' +
      '【注意】停止会中断子任务，未完成的结果会丢失；recursive 会波及整棵子树，请确认目标。',
  },
  {
    name: 'send_to_child',
    label: '追加子任务',
    description: '向运行中或暂停的子 Agent 派发任务',
    icon: '📨',
    doc:
      '【作用】向已创建的子 Agent 派发后续任务，延续其工作流。\n' +
      '【能力】指定子 chatId 与完整任务内容；running 子任务进入队列等待；paused 子新建 turn 并恢复执行。\n' +
      '【边界】仅限当前主会话下已创建的子 Agent；finished/failed/redirected 的子保持只读并返回拒绝。\n' +
      '【注意】目标子必须存在且可接收；任务内容需完整自洽，子 Agent 看不到当前对话上下文。',
  },
  {
    name: 'update_todo',
    label: '更新待办',
    description: '增删改待办事项列表',
    icon: '📋',
    doc:
      '【作用】维护任务/待办列表，跟踪多步工作的进度，让用户随时看到计划与状态。\n' +
      '【能力】增删改待办项；状态 pending/in_progress/completed；进行中项可带活动描述。\n' +
      '【边界】每次调用替换整个列表（非增量）；同一时刻最多一个 in_progress；completed 项保留在列表中不删除。\n' +
      '【注意】多步骤任务开始时先列出执行计划，复杂修改前先规划；进度变化及时更新，避免列表失真。',
  },
  {
    name: 'generate_image',
    label: '生成图片',
    description: '调用配置的图片媒体服务',
    icon: '🖼️',
    doc:
      '【作用】调用已配置的图片媒体服务，根据 prompt 生成图片。\n' +
      '【能力】按自然语言 prompt 生成；结果保存为本地媒体资产并返回 /api/media/ 路径。\n' +
      '【边界】需要已配置且可用的图片媒体服务；生成质量与风格受所选模型限制。\n' +
      '【注意】生成耗时长于普通工具；prompt 越明确（主体、风格、构图）效果越好。',
  },
  {
    name: 'generate_video',
    label: '生成视频',
    description: '调用配置的视频媒体服务',
    icon: '🎬',
    doc:
      '【作用】调用已配置的视频媒体服务，根据 prompt 生成视频片段。\n' +
      '【能力】按自然语言 prompt 生成；结果保存为本地媒体资产并返回 /api/media/ 路径。\n' +
      '【边界】需要已配置且可用的视频媒体服务；生成时长与成本明显高于图片。\n' +
      '【注意】生成耗时长；prompt 明确镜头与内容可提升可用性，避免无意义长片段。',
  },
  {
    name: 'generate_audio',
    label: '生成音频',
    description: '调用配置的音频媒体服务',
    icon: '🔊',
    doc:
      '【作用】调用已配置的音频媒体服务，根据 prompt 生成语音/音效。\n' +
      '【能力】按自然语言 prompt 生成；结果保存为本地媒体资产并返回 /api/media/ 路径。\n' +
      '【边界】需要已配置且可用的音频媒体服务；输出内容受所选模型与语言支持限制。\n' +
      '【注意】生成耗时长；描述清楚内容与风格（语速、情绪、用途）效果更好。',
  },
  {
    name: 'memory_manage',
    label: '记忆管理',
    description: '管理项目记忆（增删改查 + 淘汰归档）',
    icon: '🧠',
    doc:
      '【作用】管理跨会话的项目记忆，让 Agent 在后续对话中复用重要信息。\n' +
      '【能力】add / remove / update / list / history 五种操作；scope=global 跨 chat 共享，scope=workspace 按项目隔离；记忆分类 user/feedback/project/reference。\n' +
      '【边界】workspace 模式要求 chat 已配置工作区；每层记忆有容量上限，达上限时新增需指定淘汰目标与原因。\n' +
      '【注意】写入即持久化，注意内容质量与去重；feedback/project 类需包含 Why + How to apply 结构，便于未来复用。',
  },
  {
    name: 'ask_user_question',
    label: '询问用户',
    description: '向用户提结构化问题（2-4 选项 + 可选「其他」自由文本）',
    icon: '❓',
    doc:
      '【作用】在需要用户决策或补充信息时，提出带选项的结构化问题并等待回答。\n' +
      '【能力】2-4 个选项 + 可选「其他」自由文本；支持多选；可选 ≤12 字标题；回答结果回灌给 Agent。\n' +
      '【边界】只能问选项化问题（自由文本走「其他」）；提问后本轮会暂停等待用户回答。\n' +
      '【注意】每次提问都会打断流程，尽量合并问题、减少提问次数；选项要互斥且覆盖主要可能。',
  },
  {
    name: 'install_skill',
    label: '安装技能',
    description: '从 URL 安装技能（配置管理核心角色专用，zip/git/manifest）',
    icon: '📥',
    doc:
      '【作用】从远端 URL 安装技能到 .chery/skills/，扩展 Agent 能力库（配置管理核心角色专用）。\n' +
      '【能力】两阶段 stage→commit：先拉取并分析候选，再按用户确认落盘；支持 zip 直链 / git 仓库 / manifest 三种来源；自动规范化 SKILL.md 并记录来源追溯。\n' +
      '【边界】仅配置管理核心角色可调用；需要网络访问；写 .chery/ 属敏感操作，受监管规则约束。\n' +
      '【注意】安装前会返回候选列表，需用户逐项确认；来源不明的技能可能含恶意指令，谨慎安装。',
  },
  {
    name: 'config_manage',
    label: '配置管理',
    description:
      '管理 .chery 配置与受管资产（Cherry Nexus 独占：get/patch/rollback + asset_get/save/archive）',
    icon: '⚙️',
    doc:
      '【作用】读取、保存或回滚 .chery/config.yaml，并以引用检查 + 可恢复归档管理 prompt/skill/rule 资产。\n' +
      '【能力】get 读取完整脱敏配置、baseRevision 与备份列表；patch 提交强类型增量候选，全量校验通过后写盘并等待任务空闲重启；rollback 从备份恢复。\n' +
      '【边界】仅配置管理核心角色可用（其他角色的 senseTable 无此工具）；server 段保留不动。\n' +
      '【注意】写配置影响全局，patch 前先 get 回读确认；旧 save 会被拒绝，未知 action 会 fail-loud 返回用法。',
  },
  {
    name: 'select_conversation',
    label: '选择会话',
    description: 'Shadow 流程终止工具：选择历史会话或新对话',
    icon: '🧭',
    doc:
      '【作用】在 Shadow（会话路由）流程结束时选择目标：复用历史会话或开启新对话。\n' +
      '【能力】指定历史候选 chatId（或 null=新对话）+ 置信度与简短理由，结束当前路由流程。\n' +
      '【边界】一个流程中必须且只能调用一次。\n' +
      '【注意】调用后流程即终止，不可重复调用；理由需明确，便于追溯选择依据。',
  },
]

/**
 * 注册内置感官。
 */
function registerBuiltinSenses(): void {
  registerSenses([
    bashSense,
    readSense,
    writeSense,
    skillSense,
    searchSense,
    historyRecallSense,
    spawnSense,
    todoSense,
    memorySense,
    askSense,
    installSkillSense,
    configManageSense,
    selectConversationSense,
    ...childControlSenses,
    ...mediaSenses,
  ])
}

/**
 * 测试结果详情
 */
export interface TestResultDetail {
  passed: boolean
  passedCount: number
  totalCount: number
  failures: { input: unknown; expected: unknown; actual: unknown }[]
  error?: string
}

/**
 * 执行感官自测用例
 * 返回详细测试结果
 */
export async function runSenseTests(
  senseInstance: Sense<ZodType>,
  testCases: TestCase[],
): Promise<TestResultDetail> {
  const failures: { input: unknown; expected: unknown; actual: unknown }[] = []
  let passedCount = 0

  for (const tc of testCases) {
    try {
      const parsedInput = senseInstance.executor.schema.parse(tc.input)
      const result = await senseInstance.executor.execute(parsedInput, new Map())
      if (result.content !== tc.output.content || result.hash !== tc.output.hash) {
        failures.push({
          input: tc.input,
          expected: tc.output,
          actual: result,
        })
      } else {
        passedCount++
      }
    } catch (err) {
      return {
        passed: false,
        passedCount,
        totalCount: testCases.length,
        failures,
        error: (err as Error).message,
      }
    }
  }

  return {
    passed: failures.length === 0,
    passedCount,
    totalCount: testCases.length,
    failures,
  }
}

// 提供运行时上下文给 new Function() 执行
const runtimeContext = {
  z,
  sense,
  SupervisionLevel,
  registerSenses,
}

/**
 * 动态加载自定义感官（从编译产物目录）
 * 使用 new Function() 在当前上下文执行，无需 import
 */
async function loadCustomSenses(): Promise<void> {
  const sensesDir = join(dirname(fileURLToPath(import.meta.url)), 'senses')

  if (!existsSync(sensesDir)) {
    logger.warn(
      '⚠ 未找到编译产物目录，自定义感官未加载。请先运行 compile:senses 命令编译外部感官。',
    )
    return
  }

  const files = readdirSync(sensesDir)
  const jsFiles = files.filter((f) => f.endsWith('.js'))

  if (jsFiles.length === 0) {
    logger.warn('⚠ 未找到编译产物，自定义感官未加载。请先运行 compile:senses 命令编译外部感官。')
    return
  }

  for (const file of jsFiles) {
    const filePath = join(sensesDir, file)
    try {
      const code = readFileSync(filePath, 'utf-8')
      // 移除 hash 注释行
      const pureCode = code.replace(/^\/\/ hash:[a-f0-9]+\n/, '')

      // 使用 new Function 在当前上下文执行
      // 传入运行时上下文变量
      const fn = new Function('z', 'sense', 'SupervisionLevel', 'registerSenses', pureCode)
      const result = fn(
        runtimeContext.z,
        runtimeContext.sense,
        runtimeContext.SupervisionLevel,
        runtimeContext.registerSenses,
      )

      // 如果代码返回 sense 实例，直接注册
      if (result?.definition?.function?.name) {
        registerSenses([result])
        logger.info(`✓ 自定义感官已加载: ${result.definition.function.name}`)
      }
    } catch (err) {
      logger.warn(`⚠ 自定义感官加载失败: ${file}`, (err as Error).message)
    }
  }
}

/**
 * 重新构建全局 sense registry（内置感官 + 编译产物）。
 *
 * A 方案：供启动阶段和 compile-senses 命令结束后显式调用。
 * 长运行服务的热重载可复用该函数，但触发机制另行实现。
 */
export async function reloadSenses(): Promise<void> {
  resetSenses()
  registerBuiltinSenses()
  await loadCustomSenses()
}
