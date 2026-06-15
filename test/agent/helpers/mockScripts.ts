/**
 * 动态 mock 脚本注入：为 middleware 集成测试按需添加 mock brain + 脚本。
 *
 * flows/fixtures/.chery/config.yaml 预置了固定 brain，覆盖不了所有 middleware 边界
 * （retry error、hash 去重、单 sense 多轮等）。本 helper 在运行时向 config.llm.brain
 * 注入新 brain，并把脚本写到 .chery/mock/_agent_<name>.yaml，供 provider/mock 回放。
 *
 * config 是 import 时的单例（全局 setupFiles 已设 CHERY_DIR），运行时改其字段即生效。
 * vitest forks pool 每文件独立进程，brain 名跨文件不冲突。
 */
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";
import config, { type MockScriptResponse } from "@/utils/config.js";

const fixturesDir = process.env.CHERY_DIR ?? "";
const mockDir = resolve(fixturesDir, ".chery", "mock");

/** 构造单个脚本项（LLM 单轮响应） */
export function scriptItem(
  item: Partial<MockScriptResponse> & { senseCalls?: Array<{ id?: string; name: string; arguments: string }> },
): MockScriptResponse {
  return {
    thinking: item.thinking,
    content: item.content,
    senseCalls: item.senseCalls,
    error: item.error,
  };
}

export interface AddBrainOptions {
  /** 脚本耗尽后：repeat:"last" 重复最后一条；缺省 undefined 返回空 */
  repeat?: "last";
  /** 脚本序列 */
  script: MockScriptResponse[];
}

/**
 * 注入 mock brain + 写脚本文件。
 * @returns brain 名（即传入的 name），供 createAgent({brain: name}) 使用
 */
export function addMockBrain(name: string, opts: AddBrainOptions): string {
  mkdirSync(mockDir, { recursive: true });
  const fileName = `_agent_${name}.yaml`;
  const file = `mock/${fileName}`;
  writeFileSync(
    resolve(mockDir, fileName),
    yaml.dump({ repeat: opts.repeat, script: opts.script }),
  );
  config.llm.brain[name] = {
    model: name,
    provider: "mock",
    mock: { enabled: true, file },
  };
  return name;
}

/** content-only 单轮 brain（便捷） */
export function addContentBrain(name: string, content: string, thinking?: string): string {
  return addMockBrain(name, { repeat: "last", script: [scriptItem({ thinking, content })] });
}

/** 单 sense 调用 brain（便捷） */
export function addSenseBrain(
  name: string,
  senseName: string,
  argumentsJson: string,
  secondContent = "done",
): string {
  return addMockBrain(name, {
    repeat: "last",
    script: [
      scriptItem({
        content: "call sense",
        senseCalls: [{ id: `${name}-call-0`, name: senseName, arguments: argumentsJson }],
      }),
      scriptItem({ content: secondContent }),
    ],
  });
}
