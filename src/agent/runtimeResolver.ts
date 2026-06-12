import type {
  AdaptersGroup,
  RuntimeConfig,
  SenseEntry,
} from "@/core/middleware/types";
import type { Sense, SenseFunction } from "@/core/sense";
import type { SenseAdapter } from "@/core/sense/adapter";
import type { BrainConfig } from "@/utils/config";
import type { ZodType } from "zod";
import config from "@/utils/config";
import { SupervisionLevel } from "@/core/config";
import { getLLMAdapter } from "@/core/llm/adapter";
import { getMessageAdapter } from "@/core/message/adapter";
import { getSenseAdapter } from "@/core/sense/adapter";
import { getSense } from "@/core/sense";

export interface RuntimeSelection {
  brain: string;
  senseGroups: string[];
}

export class RuntimeResolver {
  /**
   * 原子解析完整 runtime。
   * brain、adapters、builtSenses、senseTable 必须来自同一次 selection。
   */
  resolve(selection: RuntimeSelection): RuntimeConfig {
    this.validateSelection(selection);

    const { brain, adapters } = this.resolveBrain(selection.brain);
    const { builtSenses, senseTable } = this.resolveSense(
      adapters.senseAdapter,
      selection.senseGroups,
    );

    return {
      brain,
      adapters,
      builtSenses,
      senseTable,
    };
  }

  private validateSelection(selection: RuntimeSelection): void {
    if (!selection.brain || selection.brain.trim().length === 0) {
      throw new Error("必须选择 brain");
    }
    if (!Array.isArray(selection.senseGroups) || selection.senseGroups.length === 0) {
      throw new Error("必须至少选择一个感官组");
    }
  }

  /**
   * resolve brain 名称 -> brain 配置 + provider adapters。
   */
  private resolveBrain(name: string): { brain: BrainConfig; adapters: AdaptersGroup } {
    const brain = config.llm.brain[name];
    if (!brain) {
      throw new Error(`Brain 配置 "${name}" 不存在`);
    }

    const provider = brain.provider;
    const llmAdapter = getLLMAdapter(provider);
    const messageAdapter = getMessageAdapter(provider);
    const senseAdapter = getSenseAdapter(provider);

    if (!llmAdapter || !messageAdapter || !senseAdapter) {
      throw new Error(`Provider "${provider}" adapters not registered`);
    }

    return {
      brain,
      adapters: { llmAdapter, messageAdapter, senseAdapter },
    };
  }

  /**
   * resolve senseGroups -> builtSenses（给 LLM）+ senseTable（监管等级 + 执行器）。
   *
   * 监管优先级：后缀覆盖 > 前组已解析 > 感官内置 > global。
   */
  private resolveSense(
    senseAdapter: SenseAdapter<unknown, unknown>,
    senseGroups: string[],
  ): { builtSenses: SenseFunction[]; senseTable: Map<string, SenseEntry> } {
    const resolved = new Map<string, Sense<ZodType>>();

    for (const groupName of senseGroups) {
      const group = config.sense_groups?.[groupName];
      if (!group) {
        throw new Error(`Sense group "${groupName}" 不存在`);
      }

      for (const entry of group) {
        const { senseName, supervisionLevel } = this.parseSenseGroupEntry(entry);
        const original = getSense(senseName);
        if (!original) {
          throw new Error(`Sense "${senseName}" 不存在`);
        }

        const name = original.definition.function.name;
        const prev = resolved.get(name);
        // shallow copy 隔离：supervisionLevel 写入不得污染全局 senseRegistry（多 chat 共享）
        const s: Sense<ZodType> = { ...original };
        s.supervisionLevel =
          supervisionLevel ?? prev?.supervisionLevel ?? s.supervisionLevel ?? config.global.supervision;
        resolved.set(name, s);
      }
    }

    const senses = [...resolved.values()];
    if (senses.length === 0) {
      throw new Error("所选感官组未解析出任何可用 sense");
    }

    return {
      builtSenses: senseAdapter.buildSenses(senses),
      senseTable: this.buildSenseTable(senses),
    };
  }

  private parseSenseGroupEntry(entry: string): {
    senseName: string;
    supervisionLevel?: SupervisionLevel;
  } {
    const [rawName, rawLevel] = entry.split(":");
    const senseName = rawName?.trim();
    if (!senseName) {
      throw new Error(`Sense group entry "${entry}" 无效`);
    }
    if (!rawLevel) {
      return { senseName };
    }

    const levelName = rawLevel.trim();
    const supervisionByName: Record<string, SupervisionLevel> = {
      auto: SupervisionLevel.auto,
      confirm: SupervisionLevel.confirm,
      manual: SupervisionLevel.manual,
    };
    const supervisionLevel = supervisionByName[levelName];
    if (supervisionLevel === undefined) {
      throw new Error(`Sense "${senseName}" 的监管等级 "${rawLevel}" 无效`);
    }

    return { senseName, supervisionLevel };
  }

  private buildSenseTable(senses: Sense<ZodType>[]): Map<string, SenseEntry> {
    const senseTable = new Map<string, SenseEntry>();
    for (const s of senses) {
      const name = s.definition.function.name;
      senseTable.set(name, {
        supervisionLevel: s.supervisionLevel ?? config.global.supervision,
        execute: (args, sharedData) =>
          s.executor.execute(
            args as Parameters<typeof s.executor.execute>[0],
            sharedData,
          ),
      });
    }
    return senseTable;
  }
}
