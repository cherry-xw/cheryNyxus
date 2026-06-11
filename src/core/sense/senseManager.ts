import type { Sense, SenseResult, SenseSharedData } from "./senseCreator";
import type { ZodType } from "zod";
import { SupervisionLevel } from "../config";
import { getSense } from "./senseRegistry";
import { getSenseAdapter, type SenseAdapter } from "./adapter";

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
      throw new Error(
        `Sense adapter for provider "${provider}" not registered`,
      );
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
   * 加载感官组
   * @param groupName - 感官组名称（单选）
   * @param senseGroups - 感官组配置（来自 config.sense_groups）
   * @param globalSupervision - 全局监管等级（用于 fallback）
   *
   * senses 列表支持 "read_file" 或 "execute_command:auto" 格式
   */
  loadFromGroups(
    groupName: string,
    senseGroups: Record<string, string[]> | undefined,
    globalSupervision: SupervisionLevel,
  ): void {
    const group = senseGroups?.[groupName];
    if (!group) {
      throw new Error(`Sense group "${groupName}" not found`);
    }

    for (const item of group) {
      const [name, levelStr] = item.split(":");
      const s = getSense(name!);
      if (!s) continue;

      if (levelStr) {
        const level = SupervisionLevel[levelStr as keyof typeof SupervisionLevel];
        if (level !== undefined) s.supervisionLevel = level;
      }
      s.supervisionLevel ??= globalSupervision;

      this._senses.push(s);
      this._senseMap.set(s.definition.function.name, s);
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
