import type { Sense, SenseResult, SenseSharedData } from "./senseCreator";
import type { ZodType } from "zod";
import type { SenseGroupConfig } from "@/utils/config";
import { SupervisionLevel } from "../config";
import { getSenses } from "./senseRegistry";
import { getSenseAdapter, type SenseAdapter } from "./adapter";
import { logger } from "@/utils/logger/index.js";

export class SenseManager {
  private _senses: Sense<ZodType>[] = [];
  private _senseMap: Map<string, Sense<ZodType>> = new Map();
  private _adapter: SenseAdapter<any, any>;

  /**
   * 构造函数
   * @param provider - provider 名称，用于从注册表获取 adapter
   */
  constructor(provider: string) {
    const adapter = getSenseAdapter(provider);
    if (!adapter) {
      throw new Error(`Sense adapter for provider "${provider}" not registered`);
    }
    this._adapter = adapter;
  }

  /**
   * 获取所有感官
   */
  getAll(): Sense<ZodType>[] {
    return this._senses;
  }

  /**
   * 添加感官（单个或数组）
   */
  add(sense: Sense<ZodType> | Sense<ZodType>[]): void {
    const senses = Array.isArray(sense) ? sense : [sense];
    this._senses.push(...senses);
    for (const s of senses) {
      this._senseMap.set(s.definition.function.name, s);
    }
  }

  /**
   * 根据名称查找感官
   */
  get(name: string): Sense<ZodType> | undefined {
    return this._senseMap.get(name);
  }

  /**
   * 获取底层 Sense Adapter
   */
  getAdapter(): SenseAdapter<any, any> {
    return this._adapter;
  }

  /**
   * 覆盖指定感官的监管等级（由 sense_group 配置注入）
   */
  setSupervision(senseName: string, level: import("../config").SupervisionLevel): void {
    const sense = this._senseMap.get(senseName);
    if (sense) {
      sense.supervisionLevel = level;
    }
  }

  /**
   * 批量加载感官组（封装完整的加载、去重、监管注入流程）
   * @param groupNames - 感官组名称列表
   * @param senseGroups - 感官组配置（来自 config.sense_groups）
   * @param globalSupervision - 全局监管等级（用于 fallback）
   */
  loadFromGroups(
    groupNames: string[],
    senseGroups: Record<string, SenseGroupConfig> | undefined,
    globalSupervision: SupervisionLevel,
  ): void {
    const result = new Map<string, Sense<ZodType>>();

    for (const groupName of groupNames) {
      const group = senseGroups?.[groupName];
      if (!group) {
        logger.warn(`Sense group "${groupName}" not found, skipping`);
        continue;
      }

      for (const s of getSenses(group.senses)) {
        const name = s.definition.function.name;
        const prev = result.get(name);
        if (prev) {
          logger.warn(`Sense "${name}" already loaded, overriding with group "${groupName}"`);
        }
        // 优先级：组监管 > 前组已解析监管 > 感官内置监管 > 全局默认
        s.supervisionLevel =
          group.supervision ?? prev?.supervisionLevel ?? s.supervisionLevel ?? globalSupervision;
        result.set(name, s);
      }
    }

    if (result.size > 0) {
      this.add([...result.values()]);
    }
  }

  /**
   * 执行感官
   * @param name - 感官名称
   * @param args - 感官参数
   * @param senseSharedData - 可选的senseSharedData参数，仅needsSession为true的感官需要
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    senseSharedData: SenseSharedData,
  ): Promise<SenseResult> {
    const sense = this._senseMap.get(name);
    if (!sense) {
      return {
        content: `Error: Sense "${name}" not found`,
        hash: "", // 错误情况不参与去重
      };
    }
    return sense.executor.execute(
      args as Parameters<typeof sense.executor.execute>[0],
      senseSharedData,
    );
  }
}