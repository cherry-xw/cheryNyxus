/**
 * 渲染器注册表核心逻辑。
 *
 * 设计原则：
 * - 声明式注册：内置工具一行代码声明工具名→渲染器映射
 * - 延迟加载：渲染器组件按需 import（减少首屏体积）
 * - 降级保护：渲染器加载失败自动回退到通用渲染器
 *
 * 使用方式：
 * ```typescript
 * // 注册渲染器
 * registerRenderer("update_todo", () => import("./TodoRenderer.vue"));
 *
 * // 获取渲染器（异步，失败返回 null）
 * const renderer = await getRenderer("update_todo");
 *
 * // 检查是否已注册（同步，用于预渲染判断）
 * if (hasRenderer("update_todo")) { ... }
 * ```
 */

import type { RendererComponent } from "./types";

/** 渲染器加载函数（返回 Promise<组件>） */
type RendererLoader = () => Promise<{ default: RendererComponent }>;

/**
 * 渲染器注册表：工具名 → 加载函数
 *
 * 内置工具在模块加载时自动注册。
 * MCP/自定义工具不注册，使用通用渲染器。
 */
const rendererRegistry = new Map<string, RendererLoader>();

/**
 * 注册内置工具的专用渲染器。
 *
 * @param toolName 工具名称（与 BUILTIN_SENSE_TOOLS.name 一致）
 * @param loader 渲染器组件加载函数（动态 import）
 *
 * @example
 * registerRenderer("update_todo", () => import("./TodoRenderer.vue"));
 */
export function registerRenderer(toolName: string, loader: RendererLoader): void {
  if (rendererRegistry.has(toolName)) {
    console.warn(`[RendererRegistry] 工具 "${toolName}" 已注册渲染器，将被覆盖`);
  }
  rendererRegistry.set(toolName, loader);
}

/**
 * 获取渲染器组件（异步）。
 *
 * @param toolName 工具名称
 * @returns 渲染器组件，未注册或加载失败返回 null
 *
 * @example
 * const renderer = await getRenderer("update_todo");
 * if (renderer) {
 *   // 使用专用渲染器
 * } else {
 *   // 降级到通用渲染器
 * }
 */
export async function getRenderer(toolName: string): Promise<RendererComponent | null> {
  const loader = rendererRegistry.get(toolName);
  if (!loader) return null;

  try {
    const mod = await loader();
    return mod.default;
  } catch (e) {
    console.error(`[RendererRegistry] 渲染器加载失败 (${toolName})，将降级到通用渲染`, e);
    return null; // 降级：返回 null，由分发器使用通用渲染器
  }
}

/**
 * 同步检查工具是否已注册渲染器。
 *
 * 用于预渲染判断（避免闪烁）。
 *
 * @param toolName 工具名称
 * @returns 是否已注册
 *
 * @example
 * if (hasRenderer("update_todo")) {
 *   // 渲染专用 UI
 * } else {
 *   // 渲染通用 UI
 * }
 */
export function hasRenderer(toolName: string): boolean {
  return rendererRegistry.has(toolName);
}

/**
 * 获取所有已注册的工具名（调试用）。
 *
 * @returns 已注册工具名数组
 */
export function getRegisteredTools(): string[] {
  return Array.from(rendererRegistry.keys());
}