/**
 * http.ts：http URL 构造转发层（兼容旧 import 路径）。
 *
 * 实现见 [./platform.ts](./platform.ts)，本文件仅 `re-export` 以保留
 * [App.vue] / [agentApi.ts] 等 5 处历史 import 路径不变。新代码请直接 import
 * 自 `./platform`。
 */
export { httpUrl } from "./platform";
