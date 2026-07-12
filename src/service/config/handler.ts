import type { RpcRouter, HandlerContext } from "../message/router.js";
import {
  Method,
  ErrorCode,
  createResponse,
  createError,
  type Response,
  type ConfigGetRequestData,
  type ConfigGetResponseData,
  type ConfigSaveRequestData,
  type ConfigSaveResponseData,
} from "../message/types.js";
import { readRawConfig, saveRawConfig } from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";

/**
 * Config 设置 RPC handler。
 *
 * config.get：读 .chery/config.yaml 原文（除 server 段），供设置面板编辑。
 *   返回 supervision 字符串、key 仍为 $ENV 占位符、无路径补全的原始结构。
 * config.save：校验 + 写回 .chery/config.yaml（保留 server 段、无注释）。
 *   不碰内存单例（重启生效）。校验失败返 INVALID_PARAMS + errors 列表，不写盘（规则12 fail loud）。
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

/** config.save：校验 + 写回，失败返 INVALID_PARAMS Response，成功返 needRestart */
async function handleConfigSave(
  ctx: HandlerContext,
  data: ConfigSaveRequestData,
): Promise<ConfigSaveResponseData | Response> {
  const rid = ctx.requestId ?? "";
  const result = saveRawConfig(data);
  if (!result.ok) {
    return createResponse(
      rid,
      false,
      undefined,
      createError(ErrorCode.INVALID_PARAMS, result.errors.join("\n")),
    );
  }
  // logger 在统一边界递归脱敏 key/token/secret/env 等字段。
  logger.event("config.save", { config: data });
  return { needRestart: true };
}

export function registerConfigHandlers(router: RpcRouter): void {
  router.register<ConfigGetRequestData, ConfigGetResponseData>(
    Method.CONFIG_GET,
    handleConfigGet,
  );
  router.register<ConfigSaveRequestData, ConfigSaveResponseData | Response>(
    Method.CONFIG_SAVE,
    handleConfigSave,
  );
}
