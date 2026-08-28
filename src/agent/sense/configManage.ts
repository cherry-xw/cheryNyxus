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
import fs from 'node:fs'
import path from 'node:path'

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

// 注意：不可用 z.discriminatedUnion（转 JSON Schema 顶层 required/properties 丢失 → 模型端
// required=[] → action 不被强制，LLM 会漏传）。必须普通 object + enum，保证 required 含 action。
// 详见 docs/agent/prompt-guide.md 规范 #3。
const ConfigManageSchema = z.object({
  action: z
    .enum(['get', 'save', 'rollback', 'asset_get', 'asset_save', 'asset_archive'])
    .describe(
      '操作类型，必填：get/save/rollback 管配置；asset_get/asset_save/asset_archive 管提示词、技能或规则资产',
    ),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'save 必填：完整配置对象（roles / sense_groups / global / llm / media / mcp_servers / presets 等 config.yaml 字段；server 段保留不动）。由 config_manage(action="get") 返回的完整脱敏配置改造，未改字段保留原值；敏感 key 传回 [REDACTED] 哨兵自动保留盘上原值',
    ),
  backup: z
    .string()
    .optional()
    .describe('rollback 用：回滚目标备份文件名（.chery/backups/ 下，如 config-20260821-120000.yaml）；缺省用最近一份'),
  assetPath: z
    .string()
    .optional()
    .describe('资产操作用：相对 .chery/ 的路径，仅允许 prompt/*.md、skills/* 或 rule/*.yaml'),
  content: z.string().optional().describe('asset_save 用：要原子写入的 UTF-8 文本内容'),
})

const ASSET_PATH = /^(?:prompt\/.+\.md|skills\/[^/]+(?:\/.+)?|rule\/[^/]+\.ya?ml)$/i

function resolveAsset(relativeInput: string): { relative: string; absolute: string } {
  const relative = relativeInput.replaceAll('\\', '/').replace(/^\.chery\//, '')
  if (!ASSET_PATH.test(relative) || relative.split('/').includes('..')) {
    throw new Error(
      '资产路径不在允许范围：仅允许 prompt/*.md、skills/<name>/** 或 rule/*.yaml，且禁止路径穿越',
    )
  }
  const root = path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
  const absolute = path.resolve(root, relative)
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error('资产路径越出 .chery 目录')
  }
  return { relative, absolute }
}

function assetReferences(relative: string): string[] {
  const raw = readRawConfig()
  const references: string[] = []
  if (relative.startsWith('prompt/')) {
    for (const [name, role] of Object.entries(raw.roles ?? {})) {
      if (role.systemPrompt?.replaceAll('\\', '/') === relative) references.push(`roles.${name}.systemPrompt`)
    }
  } else if (relative.startsWith('rule/')) {
    const file = relative.slice('rule/'.length)
    for (const [name, preset] of Object.entries(raw.presets ?? {})) {
      if (preset.rule === file || preset.rule === relative) references.push(`presets.${name}.rule`)
    }
  } else if (relative.startsWith('skills/')) {
    const skillName = relative.split('/')[1]!
    for (const [name, role] of Object.entries(raw.roles ?? {})) {
      // undefined means all skills are enabled, so it is an explicit live reference.
      if (role.skills === undefined || role.skills.includes(skillName)) references.push(`roles.${name}.skills`)
    }
  }
  return references
}

function assetBackupPath(relative: string): string {
  const root = path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  return path.join(root, 'backups', 'assets', stamp, relative)
}

function doAssetGet(assetPath: string): SenseResult {
  try {
    const asset = resolveAsset(assetPath)
    if (!fs.existsSync(asset.absolute) || !fs.statSync(asset.absolute).isFile()) {
      throw new Error(`资产不存在或不是文件：${asset.relative}`)
    }
    return { content: `资产 ${asset.relative}：\n${fs.readFileSync(asset.absolute, 'utf8')}`, hash: '' }
  } catch (error) {
    return { content: `读取资产失败：${(error as Error).message}`, hash: '' }
  }
}

function doAssetSave(assetPath: string, content: string): SenseResult {
  let temp: string | undefined
  let backup: string | undefined
  let movedOriginal = false
  try {
    const asset = resolveAsset(assetPath)
    if (fs.existsSync(asset.absolute) && fs.statSync(asset.absolute).isDirectory()) {
      throw new Error('asset_save 目标必须是文件，不能覆盖目录')
    }
    fs.mkdirSync(path.dirname(asset.absolute), { recursive: true })
    temp = `${asset.absolute}.candidate-${process.pid}-${Date.now()}`
    fs.writeFileSync(temp, content, 'utf8')
    if (fs.existsSync(asset.absolute)) {
      backup = assetBackupPath(asset.relative)
      fs.mkdirSync(path.dirname(backup), { recursive: true })
      // Windows rename cannot replace an existing file. Move the old version
      // to its recovery point first, then promote the fully-written candidate.
      fs.renameSync(asset.absolute, backup)
      movedOriginal = true
    }
    fs.renameSync(temp, asset.absolute)
    temp = undefined
    return {
      content: `资产已原子保存：.chery/${asset.relative}。磁盘变化将由配置修订监控器验证并在安全边界激活。`,
      hash: '',
    }
  } catch (error) {
    if (temp && fs.existsSync(temp)) fs.rmSync(temp, { force: true })
    if (movedOriginal && backup && fs.existsSync(backup)) {
      const asset = resolveAsset(assetPath)
      if (!fs.existsSync(asset.absolute)) fs.renameSync(backup, asset.absolute)
    }
    return { content: `保存资产失败，未完成替换：${(error as Error).message}`, hash: '' }
  }
}

function doAssetArchive(assetPath: string): SenseResult {
  try {
    const asset = resolveAsset(assetPath)
    if (!fs.existsSync(asset.absolute)) throw new Error(`资产不存在：${asset.relative}`)
    const references = assetReferences(asset.relative)
    if (references.length > 0) {
      throw new Error(`资产仍被引用，禁止归档：${references.join(', ')}`)
    }
    const backup = assetBackupPath(asset.relative)
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.renameSync(asset.absolute, backup)
    return {
      content:
        `资产已从活动目录移出：.chery/${asset.relative}。` +
        `可从 ${backup} 恢复；未执行不可恢复删除。`,
      hash: '',
    }
  } catch (error) {
    return { content: `归档资产被拒绝：${(error as Error).message}`, hash: '' }
  }
}

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
⚠️ action 参数必填。配置操作取 get / save / rollback；资产操作取 asset_get / asset_save / asset_archive：
1. action="get"：读取并返回 .chery/config.yaml 完整脱敏配置（roles / sense_groups / global / llm / media / mcp_servers / presets 等全量字段；敏感 key 为 [REDACTED] 哨兵，$ENV 占位符原样保留）+ .chery/backups/ 回滚点列表。任何配置操作的第一步，必须先调用。
2. action="save" + config：基于 get 返回的完整对象，仅改动目标字段后整体传回（未改字段保留原值；[REDACTED] 哨兵原样传回即保留盘上原值，显式给出新明文则以新值为准）。写盘前自动备份旧配置到 .chery/backups/（保留最近 10 份）；校验失败不落盘并返回错误。
3. action="rollback"（+ 可选 backup 文件名）：从 .chery/backups/ 恢复指定（或缺省最近）备份，撤销之前的保存。
4. asset_get/asset_save/asset_archive + assetPath：管理角色提示词、技能和规则文件。archive 会先检查当前引用并移动到 backups/assets，不做不可恢复删除；仍被引用时严格拒绝。
使用流程：先 action="get" 了解现状与锁定约束 → 用 ask_user_question 向用户确认变更（含改动前后对比、影响范围）→ action="save" 落盘 → 提示重启生效；出错先 action="rollback" 再基于报错重试。
禁止用 execute_command（cat/type/grep/head 等读取内容）或 write_file 直接读取/修改 .chery 配置（会被拦截，且绕过脱敏层）；获取 .chery 目录信息类命令（ls/dir/find/stat 列目录）不受影响。`

export default sense(
  'config_manage',
  configManageDescription,
  ConfigManageSchema,
  async (args): Promise<SenseResult> => {
    if (args.action === 'get') return doGet()
    if (args.action === 'save') {
      // config 为 optional（enum 后无法用 discriminatedUnion 表达"save 时必填"），此处显式校验
      if (!args.config) {
        return {
          content:
            '错误：config_manage action="save" 需要 config 参数（基于 get 返回的完整对象改动后整体传回）。\n' +
            '请先调用 config_manage(action="get") 获取当前配置，修改后以 action="save"+config 传回。',
          hash: '',
        }
      }
      return doSave(args.config)
    }
    if (args.action === 'rollback') return doRollback(args.backup)
    if (args.action === 'asset_get') {
      return args.assetPath
        ? doAssetGet(args.assetPath)
        : { content: '错误：asset_get 需要 assetPath。', hash: '' }
    }
    if (args.action === 'asset_save') {
      return args.assetPath && args.content !== undefined
        ? doAssetSave(args.assetPath, args.content)
        : { content: '错误：asset_save 需要 assetPath 和 content。', hash: '' }
    }
    if (args.action === 'asset_archive') {
      return args.assetPath
        ? doAssetArchive(args.assetPath)
        : { content: '错误：asset_archive 需要 assetPath。', hash: '' }
    }
    // 缺/未知 action：明确报错并给出用法，绝不静默兜底为 rollback（避免误触发无备份回滚）。
    // （运行时 schema safeParse 已在前置拦截缺 action，此处为双保险 fail-loud。）
    return {
      content:
        '错误：config_manage 必须显式指定 action，本次调用缺少或不合法，未执行任何操作。\n' +
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
