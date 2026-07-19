import type { RpcRouter, HandlerContext } from "../message/router.js";
import {
  Method,
  ErrorCode,
  createResponse,
  createError,
  type Response,
  type ConfigGetRequestData,
  type ConfigGetResponseData,
  type ConfigWorkspaceValidateRequestData,
  type ConfigWorkspaceValidateResponseData,
  type ConfigSaveRequestData,
  type ConfigSaveResponseData,
} from "../message/types.js";
import { readRawConfig, saveRawConfig, validateWorkspacePath } from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";
import { requestRestartWhenIdle } from "@/service/restartCoordinator.js";

/**
 * Config 设置 RPC handler。
 *
 * config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。
 *   返回 supervision 字符串、key 仍为 $ENV 占位符、无路径补全的原始结构。
 * config.save：校验 + 写回 .chery/config.yaml（保留 server 段、无注释）。
 *   worker 通过 IPC 请求守护进程在所有 chat 空闲时替换自己；直启 worker 则明确要求手动重启。
 */

/** config.get：读原文（剥离 server 段） */
async function handleConfigGet(
  _ctx: HandlerContext,
  _data: ConfigGetRequestData,
): Promise<ConfigGetResponseData> {
  const raw = readRawConfig();
  logger.event("config.get", { brains: Object.keys(raw.llm?.brain ?? {}).length });
  return raw;
}

/** config.workspace.validate：为设置页提供后端主机上的只读目录校验。 */
async function handleConfigWorkspaceValidate(
  _ctx: HandlerContext,
  data: ConfigWorkspaceValidateRequestData,
): Promise<ConfigWorkspaceValidateResponseData> {
  return validateWorkspacePath(data.workspace);
}

/** config.save：校验 + 写回；成功后安排空闲重启。 */
export async function handleConfigSave(
  ctx: HandlerContext,
  data: ConfigSaveRequestData,
): Promise<ConfigSaveResponseData | Response> {
  const rid = ctx.requestId ?? "";
  const result = saveRawConfig(data);
  if (!result.ok) {
    // errors（硬错误）+ warnings（软错误，如 workspace 路径无效）合并展示给 UI；
    // 仅 warnings 时也阻止写盘（提示用户修正）。
    const combined = [...result.errors, ...(result.warnings ?? [])];
    return createResponse(
      rid,
      false,
      undefined,
      createError(ErrorCode.INVALID_PARAMS, combined.join("\n")),
    );
  }
  // logger 在统一边界递归脱敏 key/token/secret/env 等字段。
  logger.event("config.save", { config: data });
  return { needRestart: true, restart: requestRestartWhenIdle() };
}

export function registerConfigHandlers(router: RpcRouter): void {
  router.register(Method.CONFIG_GET, handleConfigGet);
  router.register(Method.CONFIG_WORKSPACE_VALIDATE, handleConfigWorkspaceValidate);
  router.register(Method.CONFIG_SAVE, handleConfigSave);
}

export { handleConfigWorkspaceValidate };
