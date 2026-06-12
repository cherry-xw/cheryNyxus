import type { ZodType } from "zod";
import type { Sense } from "./senseCreator";

/**
 * 全局感官注册表：感官名 → Sense 实例
 *
 * 所有内置感官（bash/read/write/skill）和外部自定义感官在启动时注册到此表。
 * AgentBuilder.resolveSense 通过 sense_group 配置按名称从中取感官子集，摊平为 senseTable。
 *
 * 注意：此注册表是全局共享的，不同 chat 的感官隔离由 builder 按 senseGroups
 * 解析时实现（决定可见感官子集与监管等级），而非此注册表本身。
 */
const senseRegistry: Record<string, Sense<ZodType>> = {};

/**
 * 批量注册感官到全局注册表
 */
export function registerSenses(senses: Sense<ZodType>[]): void {
  for (const s of senses) {
    if (s?.definition?.function?.name) {
      senseRegistry[s.definition.function.name] = s;
    }
  }
}

/**
 * 清空全局感官注册表。
 * 用于重新编译/重新加载 sense 后重建 registry，避免已删除的外部 sense 残留。
 */
export function resetSenses(): void {
  for (const name of Object.keys(senseRegistry)) {
    delete senseRegistry[name];
  }
}

/**
 * 按名称获取单个感官实例
 */
export function getSense(name: string): Sense<ZodType> | undefined {
  return senseRegistry[name];
}
