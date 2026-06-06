import type { ZodType } from "zod";
import type { Sense } from "./senseCreator";

/**
 * 全局感官注册表：感官名 → Sense 实例
 *
 * 所有内置感官（bash/read/write/skill）和外部自定义感官在启动时注册到此表。
 * AgentBuilder 通过 sense_group 配置按名称从中取感官子集，添加到 SenseManager 实例。
 *
 * 注意：此注册表是全局共享的，不同 agent 的感官隔离由 SenseManager 实例实现，
 * 而非此注册表。sense_group 决定每个 agent 可见哪些感官。
 *
 */
const senseRegistry: Record<string, Sense<ZodType>> = {};

/**
 * 批量注册感官到全局注册表
 */
export function registerSenses(senses: Sense<ZodType>[]): void {
  for (const s of senses) {
    if (s?.definition?.function?.name) {
      const senseName = s.definition.function.name;
      senseRegistry[senseName] = s;
    }
  }
}

/**
 * 按名称批量获取感官实例
 * 自动过滤未找到的感官（不抛错）
 */
export function getSenses(names: string[]): Sense<ZodType>[] {
  return names
    .map(name => senseRegistry[name])
    .filter((s): s is Sense<ZodType> => s !== undefined);
}