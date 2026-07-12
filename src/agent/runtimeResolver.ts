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
import { getConnectedServerSenseNames } from "@/core/mcp";

export interface RuntimeSelection {
  brain: string;
  /** 单一感官组；无 Tool Call 模型时为空字符串。 */
  senseGroup: string;
  /** 启用的 MCP server 名（与 senseGroup 同层级）。enabled server 的全部 mcp__<server>__* 直接合并进 schema，绕过 sense_groups。 */
  mcpServers: string[];
}

/**
 * 解析并校验 runtime selection（brain + senseGroup + mcpServers）。
 * 供 chat.create / runtime.set 共用，methodName 用于错误消息。
 * mcpServers 缺省 []（旧 chat 向后兼容）；非数组视为非法。
 */
export function parseRuntimeSelection(
  params: { brain?: string; senseGroup?: string; mcpServers?: string[] },
  methodName: string,
): RuntimeSelection {
  if (!params.brain) throw new Error(`${methodName} requires brain`);
  const mcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
  const brain = config.llm.brain[params.brain];
  if (!brain) throw new Error(`Brain 配置 "${params.brain}" 不存在`);
  if (brain.capabilities?.toolCall === false) {
    if (params.senseGroup || mcpServers.length) throw new Error(`Brain "${params.brain}" 不支持 Tool Call，不能配置 senseGroup 或 MCP`);
    return { brain: params.brain, senseGroup: "", mcpServers: [] };
  }
  if (!params.senseGroup) throw new Error(`${methodName} requires senseGroup for a Tool Call brain`);
  return { brain: params.brain, senseGroup: params.senseGroup, mcpServers };
}

/**
 * 解析预设主 agent 编制：取 leader 角色的 RoleConfig（config.roles[leader]）作 brain+senseGroup+mcpServers
 * 的 RuntimeSelection 快照，并返回该角色的 systemPrompt 作 promptPathOverride。
 * 复用 parseRuntimeSelection（校验 brain/senseGroup 非空 + mcpServers 数组化）。
 * chat.create 选预设时调用；运行编制快照入 metadata.runtime，运行后不可改。
 */
export function resolvePresetSelection(presetName: string): {
  selection: RuntimeSelection;
  promptPathOverride?: string;
  /** 该预设选中的角色 type 列表（chat.create 快照入 metadata.spawnTypes，spawn roster gate 用） */
  spawnTypes: string[];
} {
  const preset = config.presets?.[presetName];
  if (!preset?.leader) {
    throw new Error(`预设 "${presetName}" 不存在或未指定 leader 角色（可用：${Object.keys(config.presets ?? {}).join(", ") || "（未配置任何预设）"}）`);
  }
  // 主 pet 编制取 leader 角色的 RoleConfig（config.roles 单一源）。
  const leader = config.roles?.[preset.leader];
  if (!leader) {
    throw new Error(`预设 "${presetName}" 的 leader 角色 "${preset.leader}" 不在 config.roles（可用：${Object.keys(config.roles ?? {}).join(", ") || "（未配置任何角色）"}）`);
  }
  const selection = parseRuntimeSelection(
    { brain: leader.brain, senseGroup: leader.senseGroup, mcpServers: leader.mcpServers ?? [] },
    `presets.${presetName}.leader(${preset.leader})`,
  );
  return { selection, promptPathOverride: leader.systemPrompt, spawnTypes: preset.roles ?? [] };
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
      selection.senseGroup,
      selection.mcpServers,
      brain.capabilities?.generate,
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
    const brain = config.llm.brain[selection.brain];
    if (brain?.capabilities?.toolCall !== false && !selection.senseGroup) throw new Error("支持 Tool Call 的模型必须选择一个感官组");
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
   * resolve senseGroup + mcpServers -> builtSenses（给 LLM）+ senseTable（监管等级 + 执行器）。
   *
   * 监管优先级：后缀覆盖（:level）> 感官内置 > global。（单组化后不再有跨组覆盖合并）
   *
   * MCP 挂载：mcpServers 绕过 sense_groups，enabled server 的全部 mcp__<server>__* sense
   * 直接合并进 resolved Map（去重冲突 MCP 覆盖）；监管用 sense 自带 server 级 supervision
   * （无 :level 覆盖）。未连 server 由 getConnectedServerSenseNames 抛 NOT_FOUND（fail loud）。
   */
  private resolveSense(
    senseAdapter: SenseAdapter<unknown>,
    senseGroup: string,
    mcpServers: string[],
    generateCapabilities?: { image?: boolean; video?: boolean; audio?: boolean },
  ): { builtSenses: SenseFunction[]; senseTable: Map<string, SenseEntry> } {
    const resolved = new Map<string, Sense<ZodType>>();

    if (!senseGroup) return { builtSenses: [], senseTable: new Map() };
    const group = config.sense_groups?.[senseGroup];
    if (!group) {
      throw new Error(`Sense group "${senseGroup}" 不存在`);
    }

    for (const entry of group) {
      const { senseName, supervisionLevel } = this.parseSenseGroupEntry(entry);
      const mediaKind = senseName.match(/^generate_(image|video|audio)$/)?.[1] as "image" | "video" | "audio" | undefined;
      if (mediaKind && !generateCapabilities?.[mediaKind]) continue;
      const original = getSense(senseName);
      if (!original) {
        throw new Error(`Sense "${senseName}" 不存在`);
      }

      const name = original.definition.function.name;
      // shallow copy 隔离：supervisionLevel 写入不得污染全局 senseRegistry（多 chat 共享）
      const s: Sense<ZodType> = { ...original };
      s.supervisionLevel =
        supervisionLevel ?? s.supervisionLevel ?? config.global.supervision;
      resolved.set(name, s);
    }

    // MCP server 的全部 sense 合并进 schema（绕过 sense_groups，监管用 server 级默认）
    for (const serverName of mcpServers) {
      for (const senseName of getConnectedServerSenseNames(serverName)) {
        const original = getSense(senseName);
        if (!original) continue; // registry 中已不存在（理论上不应发生，连接时注册）
        const s: Sense<ZodType> = { ...original };
        s.supervisionLevel = original.supervisionLevel ?? config.global.supervision;
        resolved.set(original.definition.function.name, s);
      }
    }

    const senses = [...resolved.values()];
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
        execute: (args, sharedData, ctx) =>
          s.executor.execute(
            args as Parameters<typeof s.executor.execute>[0],
            sharedData,
            ctx,
          ),
      });
    }
    return senseTable;
  }
}
