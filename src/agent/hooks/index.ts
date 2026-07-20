/**
 * Hooks 模块 barrel。
 *
 * 启动期调用 `loadHookRegistry()` 一次性解析到内存；dispatch 时按需 spawn handler。
 *
 * 详见 [docs/agent/hooks.md](../../../../docs/agent/hooks.md)。
 */

export { dispatch } from './dispatch.js'
export { loadHookRegistry, clearHookRegistry, type HookHandlerMap } from './registry.js'
export type { HookEvent, HookDispatchContext, HookPayloadMap, HookDecisionMap } from './types.js'
export type { HookHandlerConfig } from './matcher.js'
