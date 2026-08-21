import { z } from 'zod'
import { sense, type SenseResult } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import {
  readRawConfig,
  saveRawConfig,
  rollbackConfig,
  listConfigBackups,
  type ConfigRaw,
} from '@/utils/config.js'

/**
 * config_manage 感官：配置管理核心角色（cheryNyxus）专用，读写 .chery/config.yaml。
 *
 * action 三态：
 *   - get：readRawConfig() 读盘（剥离 server 段），返回精简摘要（roles 列表 + 锁定状态 +
 *     sense_groups / global.supervision / llm.brain 概览 + backups 回滚点）。
 *   - save：复用 saveRawConfig()（校验 + 锁角色/固定预设编辑校验 + 写盘）。
 *     写盘前 saveRawConfig 层自动备份旧配置到 .chery/backups/（保留最近 10 份），出错可 rollback。
 *   - rollback：从 .chery/backups/ 恢复指定（或缺省最近）备份到 config.yaml。
 *
 * 结构化感官（action 参数无路径）→ extractSensePaths 返回 []，天然不触发 .chery/ 路径守卫。
 * 仅 cheryNyxus 的 senseGroup（chery_nexus）含此感官 → 其他角色 senseTable 无此感官 → 调不到。
 * 监管 smart：写配置 = 高影响操作，需规则表放行（默认确认）。
 *
 * 详见 docs/agent/config-manage.md。
 */

const getSchema = z.object({
  action: z.literal('get'),
})

const saveSchema = z.object({
  action: z.literal('save'),
  config: z
    .record(z.string(), z.unknown())
    .describe(
      '完整配置对象（roles / sense_groups / global / llm / presets 等 config.yaml 字段；server 段保留不动）。由 config_manage(action="get") 摘要 + 字段参考表构造，未改字段保留原值',
    ),
})

const rollbackSchema = z.object({
  action: z.literal('rollback'),
  backup: z
    .string()
    .optional()
    .describe('回滚目标备份文件名（.chery/backups/ 下，如 config-20260821-120000.yaml）；缺省用最近一份'),
})

/** get：读盘返回精简配置摘要（供定位目标字段 + 了解锁定约束）。 */
function doGet(): SenseResult {
  const raw = readRawConfig()
  const roles = Object.entries(raw.roles ?? {}).map(([name, cfg]) => ({
    name,
    senseGroup: cfg.senseGroup,
    lock: cfg.lock === true,
    kind: cfg.kind ?? 'role',
  }))
  const summary = {
    roles,
    sense_groups: raw.sense_groups,
    global: raw.global,
    llm_brain_names: Object.keys(raw.llm?.brain ?? {}),
    presets: Object.entries(raw.presets ?? {}).map(([name, cfg]) => ({
      name,
      leader: cfg.leader,
      roles: cfg.roles,
      schedule: cfg.schedule ?? null,
    })),
    backups: listConfigBackups(),
  }
  return {
    content:
      `当前 .chery/config.yaml 配置摘要：\n` +
      JSON.stringify(summary, null, 2) +
      `\n请对照 .chery.template/docs/ 字段参考表定位目标字段，构造 config_manage(action="save") 传回完整配置对象。`,
    hash: '',
  }
}

/** save：复用 saveRawConfig 校验 + 写盘（自动备份旧配置）。校验失败不落盘。 */
function doSave(config: Record<string, unknown>): SenseResult {
  const result = saveRawConfig(config as unknown as ConfigRaw)
  if (!result.ok) {
    const combined = [...result.errors, ...(result.warnings ?? [])]
    return {
      content:
        `配置保存被拒绝，未落盘：\n${combined.join('\n')}\n` +
        `可基于报错调整 config 后重试 save；如需撤销已落盘变更用 action="rollback"。`,
      hash: '',
    }
  }
  return {
    content:
      '配置已保存到 .chery/config.yaml（写盘前旧配置已自动备份到 .chery/backups/，保留最近 10 份）。' +
      '注意：配置不热更，需要重启进程才能生效。',
    hash: '',
  }
}

/** rollback：从 .chery/backups/ 恢复指定（或缺省最近）备份到 config.yaml。 */
function doRollback(backup: string | undefined): SenseResult {
  const { backup: restored } = rollbackConfig(backup)
  return {
    content:
      `已从 .chery/backups/${restored} 恢复到 .chery/config.yaml（回滚完成）。` +
      '注意：配置不热更，需要重启进程才能生效；若回滚后仍需调整，可基于当前配置继续 save。',
    hash: '',
  }
}

const configManageDescription = `管理 .chery/config.yaml 配置（配置管理核心角色 cheryNyxus 专用）。
action 三态：
1. action="get"：读当前配置，返回精简摘要（roles 列表 + 锁定状态 + sense_groups + global + llm.brain 概览 + backups 回滚点）。
2. action="save" + config：保存完整配置对象（roles / sense_groups / global / llm / presets 等；server 段保留不动）。
   写盘前自动备份旧配置到 .chery/backups/（保留最近 10 份）。校验失败不落盘并返回错误。
3. action="rollback"（+ 可选 backup）：从 .chery/backups/ 恢复指定（或缺省最近）备份，撤销之前的保存。
使用流程：先 get 了解现状与锁定约束 → 用 ask_user_question 向用户确认变更（含改动前后对比、影响范围）→ save 落盘 → 提示重启生效；出错先 rollback 再基于报错重试。`

export default sense(
  'config_manage',
  configManageDescription,
  z.discriminatedUnion('action', [getSchema, saveSchema, rollbackSchema]),
  async (args): Promise<SenseResult> => {
    if (args.action === 'get') return doGet()
    if (args.action === 'save') return doSave(args.config)
    return doRollback(args.backup)
  },
  SupervisionLevel.smart,
)
