import { z } from 'zod'
import { sense, type SenseResult } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import {
  readRawConfig,
  saveRawConfig,
  rollbackConfig,
  listConfigBackups,
  redactConfigSecrets,
  restoreRedactedSecrets,
  type ConfigRaw,
} from '@/utils/config.js'

/**
 * config_manage 感官：配置管理核心角色（cheryNyxus）专用，读写 .chery/config.yaml。
 *
 * action 三态：
 *   - get：readRawConfig() 读盘（剥离 server 段），经 redactConfigSecrets 脱敏后返回**完整配置**
 *     （key 为 $ENV 占位符原样 / [REDACTED] 哨兵）+ backups 回滚点，可直接 round-trip 传回 save。
 *   - save：先 readRawConfig() 读盘 → restoreRedactedSecrets 把 [REDACTED] 还原为盘上原值 →
 *     复用 saveRawConfig()（校验 + 锁角色/固定预设编辑校验 + 写盘）。
 *     写盘前 saveRawConfig 层自动备份旧配置到 .chery/backups/（保留最近 10 份），出错可 rollback。
 *   - rollback：从 .chery/backups/ 恢复指定（或缺省最近）备份到 config.yaml。
 *
 * 结构化感官（action 参数无路径）→ extractSensePaths 返回 []，天然不触发 .chery/ 路径守卫。
 * 仅 cheryNyxus 的 senseGroup（chery_nexus）含此感官 → 其他角色 senseTable 无此感官 → 调不到。
 * 监管 smart：写配置 = 高影响操作，需规则表放行（默认确认）。
 * 缺/未知 action → fail-loud 返回用法引导（绝不静默兜底为 rollback，避免误报"备份目录不存在"）。
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
      '完整配置对象（roles / sense_groups / global / llm / media / mcp_servers / presets 等 config.yaml 字段；server 段保留不动）。由 config_manage(action="get") 返回的完整脱敏配置改造，未改字段保留原值；敏感 key 传回 [REDACTED] 哨兵自动保留盘上原值',
    ),
})

const rollbackSchema = z.object({
  action: z.literal('rollback'),
  backup: z
    .string()
    .optional()
    .describe('回滚目标备份文件名（.chery/backups/ 下，如 config-20260821-120000.yaml）；缺省用最近一份'),
})

/** get：读盘返回完整脱敏配置（可 round-trip 传回 save）+ backups 回滚点。backups 独立于 config 对象，避免污染 save 入参。 */
function doGet(): SenseResult {
  const raw = readRawConfig()
  const config = redactConfigSecrets(raw)
  const backups = listConfigBackups()
  return {
    content:
      `当前 .chery/config.yaml 配置（完整、已脱敏，可直接 round-trip 传给 config_manage(action="save")）：\n` +
      JSON.stringify(config, null, 2) +
      `\n回滚点（.chery/backups/，最近在前）：\n` +
      (backups.length ? backups.join('\n') : '（无）') +
      `\n说明：未改字段保留原值；敏感 key 字段为 [REDACTED] 哨兵（$ENV 占位符原样保留），` +
      `save 时原样传回 [REDACTED] 即保留盘上原值，显式给出新值则以新值为准。`,
    hash: '',
  }
}

/** save：先读盘还原 [REDACTED] 为盘上原值，再复用 saveRawConfig 校验 + 写盘（自动备份旧配置）。校验失败不落盘。 */
function doSave(config: Record<string, unknown>): SenseResult {
  const disk = readRawConfig()
  const restored = restoreRedactedSecrets(config as unknown as ConfigRaw, disk)
  const result = saveRawConfig(restored)
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

/** rollback：从 .chery/backups/ 恢复指定（或缺省最近）备份到 config.yaml。无备份时返回可行动报错而非抛异常。 */
function doRollback(backup: string | undefined): SenseResult {
  try {
    const { backup: restored } = rollbackConfig(backup)
    return {
      content:
        `已从 .chery/backups/${restored} 恢复到 .chery/config.yaml（回滚完成）。` +
        '注意：配置不热更，需要重启进程才能生效；若回滚后仍需调整，可基于当前配置继续 save。',
      hash: '',
    }
  } catch (error) {
    return {
      content:
        `回滚失败：${(error as Error).message}\n` +
        '可通过 config_manage(action="get") 查看当前 .chery/backups/ 回滚点；首次 action="save" 后才会生成备份。',
      hash: '',
    }
  }
}

const configManageDescription = `管理 .chery/config.yaml 配置（配置管理核心角色 cheryNyxus 专用）。本感官是读写 .chery 配置的唯一正式通道，可完整替代对配置文件的直接指令读写（get 读 / save 写 / rollback 恢复）。
⚠️ action 参数必填，必须且只能取 get / save / rollback 三者之一：
1. action="get"：读取并返回 .chery/config.yaml 完整脱敏配置（roles / sense_groups / global / llm / media / mcp_servers / presets 等全量字段；敏感 key 为 [REDACTED] 哨兵，$ENV 占位符原样保留）+ .chery/backups/ 回滚点列表。任何配置操作的第一步，必须先调用。
2. action="save" + config：基于 get 返回的完整对象，仅改动目标字段后整体传回（未改字段保留原值；[REDACTED] 哨兵原样传回即保留盘上原值，显式给出新明文则以新值为准）。写盘前自动备份旧配置到 .chery/backups/（保留最近 10 份）；校验失败不落盘并返回错误。
3. action="rollback"（+ 可选 backup 文件名）：从 .chery/backups/ 恢复指定（或缺省最近）备份，撤销之前的保存。
使用流程：先 action="get" 了解现状与锁定约束 → 用 ask_user_question 向用户确认变更（含改动前后对比、影响范围）→ action="save" 落盘 → 提示重启生效；出错先 action="rollback" 再基于报错重试。
禁止用 execute_command（cat/type/grep/head 等读取内容）或 write_file 直接读取/修改 .chery 配置（会被拦截，且绕过脱敏层）；获取 .chery 目录信息类命令（ls/dir/find/stat 列目录）不受影响。`

export default sense(
  'config_manage',
  configManageDescription,
  z.discriminatedUnion('action', [getSchema, saveSchema, rollbackSchema]),
  async (args): Promise<SenseResult> => {
    if (args.action === 'get') return doGet()
    if (args.action === 'save') return doSave(args.config)
    if (args.action === 'rollback') return doRollback(args.backup)
    // 缺/未知 action：明确报错并给出用法，绝不静默兜底为 rollback（避免误触发无备份回滚）。
    return {
      content:
        '错误：config_manage 必须显式指定 action（get / save / rollback），本次调用缺少 action，未执行任何操作。\n' +
        '用法：\n' +
        '  1. action="get"：读取 .chery/config.yaml 完整脱敏配置（任何配置操作的第一步）。\n' +
        '  2. action="save" + config：基于 get 返回的对象修改后整体传回。\n' +
        '  3. action="rollback"（+ 可选 backup 文件名）：从 .chery/backups/ 恢复指定（或缺省最近）备份。\n' +
        '请先调用 config_manage(action="get") 获取当前配置。',
      hash: '',
    }
  },
  SupervisionLevel.smart,
)
