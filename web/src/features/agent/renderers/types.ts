/**
 * 工具参数类型定义（前端专用）。
 *
 * 与后端 schema 同步，供专用渲染器使用。
 * 避免在组件内重复定义（如原 TodoSenseBox/TodoPanel）。
 *
 * 同步责任：
 * - 后端 schema 位于 src/agent/sense/*.ts（zod 定义）
 * - 前端类型需手动同步（通过文档约定）
 * - TypeScript 严格模式检查类型安全
 */

// ============== update_todo 参数类型 ==============

/** 待办状态（与后端 zod enum 同步） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/** 待办项（与后端 TodoItemSchema 同步） */
export interface TodoItem {
  /** 待办内容 */
  content: string
  /** 状态：pending（待处理）/ in_progress（进行中）/ completed（已完成） */
  status: TodoStatus
  /** 进行中的活动形式（可选，用于 in_progress 状态时显示副标题） */
  activeForm?: string
}

/** update_todo 工具参数 */
export interface UpdateTodoArgs {
  /** 待办列表 */
  todos: TodoItem[]
}

// ============== execute_command 参数类型 ==============

/** execute_command 工具参数 */
export interface ExecuteCommandArgs {
  /** 要执行的命令 */
  command: string
  /** 命令说明 */
  description: string
}

/** execute_command 工具结果 */
export interface ExecuteCommandResult {
  /** 执行状态 */
  status: 'success' | 'timeout' | 'error'
  /** 进程 ID */
  pid: number
  /** 退出码（可选） */
  exitCode?: number
  /** 执行时长（毫秒） */
  duration: number
  /** 执行的命令 */
  command: string
  /** 命令说明 */
  description: string
  /** 输出内容 */
  output: string
  /** 日志文件路径（可选） */
  logPath?: string
  /** 错误信息（可选） */
  message?: string
}

// ============== read_file 参数类型 ==============

/** 压缩策略 */
export type CompressionStrategy = 'auto' | 'truncate' | 'drain' | 'none'

/** read_file 工具参数 */
export interface ReadFileArgs {
  /** 文件绝对路径 */
  path: string
  /** 读取行数限制（可选） */
  limit?: number
  /** 起始行偏移（可选，从 0 开始） */
  offset?: number
  /** 压缩策略（可选） */
  compression?: CompressionStrategy
}

// ============== write_file 参数类型 ==============

/** write_file 工具参数 */
export interface WriteFileArgs {
  /** 文件绝对路径 */
  path: string
  /** 写入内容 */
  content: string
  /** 起始行号（可选，0-based，必须与 limit 同时指定） */
  offset?: number
  /** 要替换的行数（可选，必须与 offset 同时指定） */
  limit?: number
}

// ============== generate_* 参数类型（共享） ==============

/** 媒体类型 */
export type MediaKind = 'image' | 'video' | 'audio'

/** generate_image/video/audio 工具参数（共享） */
export interface GenerateMediaArgs {
  /** 生成提示词 */
  prompt: string
}

// ============== search_codebase 参数类型 ==============

/** 搜索模式 */
export type SearchMode = 'content' | 'filename'

/** search_codebase 工具参数 */
export interface SearchCodebaseArgs {
  /** 搜索模式（可选，默认 content） */
  mode?: SearchMode
  /** 搜索根目录 */
  path: string
  /** 搜索查询字符串 */
  query: string
  /** 是否正则匹配（可选，content 模式） */
  regex?: boolean
  /** 返回结果上限（可选，默认 50） */
  maxResults?: number
  /** 上下文行数（可选，content 模式） */
  contextLines?: number
}

// ============== spawn_role 参数类型 ==============

/** spawn_role 工具参数 */
export interface SpawnRoleArgs {
  /** 角色类型名 */
  type: string
  /** 交付角色执行的任务描述 */
  prompt: string
  /** 是否等待角色结果（可选，默认 false） */
  wait?: boolean
}

// ============== skill 参数类型 ==============

/** skill 工具参数 */
export interface SkillArgs {
  /** 技能名称 */
  name: string
}

// ============== 渲染器 Props 契约 ==============

import type { SenseCallRecord } from '@/stores/agents'

/**
 * 所有专用渲染器的 Props 契约。
 *
 * 渲染器只负责显示，不处理业务逻辑：
 * - ✅ 解析参数并渲染 UI
 * - ✅ 显示工具状态（running/done/error）
 * - ✅ 提供交互元素（折叠、展开、复制等）
 * - ❌ 不修改 store 状态
 * - ❌ 不发送 RPC 请求
 * - ❌ 不执行副作用
 */
export interface RendererProps {
  /** 原始调用记录（含 name/args/result/status） */
  call: SenseCallRecord
  /** 解析后的参数（类型安全，由分发器预处理） */
  parsedArgs?: unknown
  /** DOM ID（用于可访问性） */
  id?: string
}

/**
 * 渲染器组件定义（Vue 组件类型）。
 * 使用宽松类型以兼容 Vue 组件的实际类型。
 */
import type { Component } from 'vue'
export type RendererComponent = Component<RendererProps>
