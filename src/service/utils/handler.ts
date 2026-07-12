import OpenAI from "openai";
import { Ollama } from "ollama";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type UtilsModelsRequestData,
  type UtilsModelsResponseData,
  type EnvListRequestData,
  type EnvListResponseData,
} from "../message/types.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";
import { replaceEnvVars, listEnvVarNames } from "@/utils/config.js";

/**
 * utils.models：基于用户提供的 provider/url/key 拉取可用模型列表。
 * 请求失败时返回 { models: [], error }，不抛 RpcError（前端可展示错误提示）。
 */
export async function handleUtilsModels(
  _ctx: HandlerContext,
  data: UtilsModelsRequestData,
): Promise<UtilsModelsResponseData> {
  const provider = data.provider;
  const url = replaceEnvVars(data.url) as string;
  const key = data.key ? (replaceEnvVars(data.key) as string) : undefined;

  try {
    switch (provider) {
      case "openai":
        return await fetchOpenAIModels(url, key);
      case "ollama":
        return await fetchOllamaModels(url);
      default:
        return { models: [], error: `不支持的 provider: ${provider}（当前支持 openai / ollama）` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.event("utils.models.error", { provider, url, error: message }, LogLevel.warn);
    return { models: [], error: message };
  }
}

async function fetchOpenAIModels(
  url: string,
  key?: string,
): Promise<UtilsModelsResponseData> {
  const client = new OpenAI({ baseURL: url, apiKey: key ?? "" });
  const response = await client.models.list();
  return {
    models: response.data.map((m) => ({
      id: m.id,
      name: m.id,
      ownedBy: m.owned_by,
    })),
  };
}

async function fetchOllamaModels(
  url: string,
): Promise<UtilsModelsResponseData> {
  const client = new Ollama({ host: url });
  const response = await client.list();
  return {
    models: (response.models ?? []).map((m) => ({
      id: m.name ?? m.model ?? "",
      name: m.name ?? m.model,
    })),
  };
}

/**
 * env.list：返回 .env 文件中的变量名列表（供前端密钥下拉选择）。
 */
export async function handleEnvList(
  _ctx: HandlerContext,
  _data: EnvListRequestData,
): Promise<EnvListResponseData> {
  return { vars: listEnvVarNames() };
}

/**
 * 注册 Utils handlers
 */
export function registerUtilsHandlers(
  router: import("../message/router.js").RpcRouter,
): void {
  router.register<UtilsModelsRequestData, UtilsModelsResponseData>(
    Method.UTILS_MODELS,
    handleUtilsModels,
  );
  router.register<EnvListRequestData, EnvListResponseData>(
    Method.ENV_LIST,
    handleEnvList,
  );
}
