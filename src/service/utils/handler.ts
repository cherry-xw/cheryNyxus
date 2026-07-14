import OpenAI from "openai";
import { Ollama } from "ollama";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { statSync } from "node:fs";
import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type UtilsModelsRequestData,
  type UtilsModelsResponseData,
  type EnvListRequestData,
  type EnvListResponseData,
  type UtilsOpenFileRequestData,
  type UtilsOpenFileResponseData,
  type UtilsOpenConfigDirRequestData,
  type UtilsOpenConfigDirResponseData,
  type UtilsEditorsRequestData,
  type UtilsEditorsResponseData,
  type UtilsThinkingLevelsRequestData,
  type UtilsThinkingLevelsResponseData,
} from "../message/types.js";
import { logger } from "@/utils/logger/index.js";
import { LogLevel } from "@/utils/logger/types.js";
import { replaceEnvVars, listEnvVarNames, getCheryDir } from "@/utils/config.js";
import config from "@/utils/config.js";
import { resolveThinkingLevelsBatch } from "@/utils/modelThinking.js";
import { openWithSystem } from "./openWithSystem.js";

const exec = promisify(execCallback);

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
 * utils.openFile：打开指定文件（用配置的文本编辑器或系统默认）。
 * path：相对 CHERY_DIR 的文件路径（如 .env、.chery/config.yaml）。
 * 由后端进程使用配置的 textEditor 或系统默认应用打开。
 */
export async function handleUtilsOpenFile(
  _ctx: HandlerContext,
  data: UtilsOpenFileRequestData,
): Promise<UtilsOpenFileResponseData> {
  const cheryDir = getCheryDir();
  const filePath = join(cheryDir, data.path);

  // 优先使用配置的文本编辑器
  const textEditor = config.global.textEditor;

  if (textEditor) {
    // 使用配置的编辑器打开文件
    const editor = replaceEnvVars(textEditor) as string;
    logger.event("utils.openFile", { path: filePath, editor }, LogLevel.info);

    // 根据操作系统选择打开方式
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "win32") {
      // Windows: 直接使用编辑器命令
      command = editor;
      args = [filePath];
    } else if (platform === "darwin") {
      // macOS: 使用 open 命令
      if (editor === "vscode" || editor.includes("Visual Studio Code")) {
        command = "open";
        args = ["-a", "Visual Studio Code", filePath];
      } else {
        command = "open";
        args = ["-a", editor, filePath];
      }
    } else {
      // Linux: 直接使用编辑器命令
      command = editor;
      args = [filePath];
    }

    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } else {
    logger.event("utils.openFile", { path: filePath, editor: "system default" }, LogLevel.info);
    await openWithSystem(filePath);
  }

  return {};
}

/** utils.openConfigDir：固定打开后端主机的 CHERY_DIR/.chery 配置目录。 */
export async function handleUtilsOpenConfigDir(
  _ctx: HandlerContext,
  _data: UtilsOpenConfigDirRequestData,
): Promise<UtilsOpenConfigDirResponseData> {
  const configDir = join(getCheryDir(), ".chery");
  let isDirectory = false;
  try {
    isDirectory = statSync(configDir).isDirectory();
  } catch {
    // 统一在下方返回包含实际目标路径的错误。
  }
  if (!isDirectory) {
    throw new Error(`配置目录不存在或不是目录: ${configDir}`);
  }

  logger.event("utils.openConfigDir", { path: configDir }, LogLevel.info);
  await openWithSystem(configDir);
  return {};
}

/**
 * 检测系统可用的文本编辑器。
 * Windows: VSCode (code)、记事本 (notepad)
 * macOS: VSCode (code)、TextEdit (系统自带)
 * Linux: VSCode (code)、gedit
 */
async function detectAvailableEditors(): Promise<Array<{ name: string; command: string; available: boolean }>> {
  const platform = process.platform;
  const editors: Array<{ name: string; command: string; available: boolean }> = [];

  // VSCode 检测（跨平台）
  try {
    const vscodeCmd = platform === "win32" ? "where code" : "which code";
    await exec(vscodeCmd, { timeout: 2000 });
    editors.push({ name: "Visual Studio Code", command: "code", available: true });
  } catch {
    editors.push({ name: "Visual Studio Code", command: "code", available: false });
  }

  if (platform === "win32") {
    // Windows: 记事本（系统自带，始终可用）
    editors.push({ name: "记事本", command: "notepad", available: true });
  } else if (platform === "darwin") {
    // macOS: TextEdit（系统自带，始终可用）
    editors.push({ name: "TextEdit", command: "TextEdit", available: true });
  } else {
    // Linux: gedit 检测
    try {
      await exec("which gedit", { timeout: 2000 });
      editors.push({ name: "gedit", command: "gedit", available: true });
    } catch {
      editors.push({ name: "gedit", command: "gedit", available: false });
    }
  }

  return editors;
}

/**
 * utils.editors：返回系统可用的文本编辑器列表（供前端下拉选择）。
 */
export async function handleUtilsEditors(
  _ctx: HandlerContext,
  _data: UtilsEditorsRequestData,
): Promise<UtilsEditorsResponseData> {
  const editors = await detectAvailableEditors();
  return { editors };
}

/**
 * utils.thinkingLevels：按模型名批量查询 ThinkingLevel 档位列表。
 * 来源：[modelThinking.ts](../../utils/modelThinking.ts) 加载的 `.chery/model-thinking.yaml`。
 * 未命中或配置缺失 → 兜底返回 `["off", "thinking"]`。
 * 失败不抛错（仍返回部分结果 + 全量兜底），前端总能拿到有效档位。
 */
export async function handleUtilsThinkingLevels(
  _ctx: HandlerContext,
  data: UtilsThinkingLevelsRequestData,
): Promise<UtilsThinkingLevelsResponseData> {
  try {
    const levels = resolveThinkingLevelsBatch(data.models ?? []);
    // 展开 readonly → 可变数组（响应 DTO 用 mutable ThinkingLevel[]）
    const mutable: Record<string, import("@/core/llm/adapter.js").ThinkingLevel[]> = {};
    for (const [k, v] of Object.entries(levels)) {
      mutable[k] = [...v];
    }
    return { levels: mutable };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.event("utils.thinkingLevels.error", { error: message }, LogLevel.warn);
    // 兜底：所有 model 给 ["off", "thinking"]
    const fallback: Record<string, import("@/core/llm/adapter.js").ThinkingLevel[]> = {};
    for (const m of data.models ?? []) {
      if (typeof m === "string" && m.length > 0) fallback[m] = ["off", "thinking"];
    }
    return { levels: fallback };
  }
}

/**
 * 注册 Utils handlers
 */
export function registerUtilsHandlers(
  router: import("../message/router.js").RpcRouter,
): void {
  router.register(Method.UTILS_MODELS, handleUtilsModels);
  router.register(Method.ENV_LIST, handleEnvList);
  router.register(Method.UTILS_OPEN_FILE, handleUtilsOpenFile);
  router.register(Method.UTILS_OPEN_CONFIG_DIR, handleUtilsOpenConfigDir);
  router.register(Method.UTILS_EDITORS, handleUtilsEditors);
  router.register(Method.UTILS_THINKING_LEVELS, handleUtilsThinkingLevels);
}
