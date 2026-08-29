import { z } from 'zod'
import { sense, type SenseResult } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import {
  readRawConfig,
  rollbackConfig,
  listConfigBackups,
  redactConfigSecrets,
} from '@/utils/config.js'
import {
  applyConfigOperations,
  configOperationsSchema,
  getConfigBaseRevision,
  type ConfigOperation,
} from '@/service/config/operations.js'
import { commitConfigCandidate } from '@/service/config/commit.js'
import fs from 'node:fs'
import path from 'node:path'

/**
 * config_manage 感官：配置管理核心角色（cheryNyxus）专用，读写 .chery/config.yaml。
 *
 * 配置 action：
 *   - get：返回完整脱敏配置、覆盖全部可编辑字段的 baseRevision 与 backups 回滚点。
 *   - patch：把强类型资源操作应用到当前磁盘快照，完整校验候选后写盘，并安排空闲重启。
 *   - save：旧全量协议仅返回迁移指引，不执行写入。
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
    .enum(['get', 'patch', 'save', 'rollback', 'asset_get', 'asset_save', 'asset_archive'])
    .describe(
      '操作类型，必填：get/patch/rollback 管配置；save 已停用；asset_get/asset_save/asset_archive 管提示词、技能或规则资产',
    ),
  baseRevision: z
    .string()
    .optional()
    .describe(
      'patch 必填：必须原样使用最近一次 get 返回的 baseRevision；磁盘配置变化后旧值会被拒绝',
    ),
  operations: configOperationsSchema
    .optional()
    .describe('patch 必填：1 到 50 个强类型资源级 put/remove 操作，按数组顺序原子应用'),
  backup: z
    .string()
    .optional()
    .describe(
      'rollback 用：回滚目标备份文件名（.chery/backups/ 下，如 config-20260821-120000.yaml）；缺省用最近一份',
    ),
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

/** get：读盘返回完整脱敏配置、乐观并发 revision 与 backups 回滚点。 */
function doGet(): SenseResult {
  const raw = readRawConfig()
  const config = redactConfigSecrets(raw)
  const baseRevision = getConfigBaseRevision(raw)
  const backups = listConfigBackups()
  return {
    content:
      `当前 .chery/config.yaml 配置（完整、已脱敏，仅用于定位目标资源）：\n` +
      JSON.stringify(config, null, 2) +
      `\nbaseRevision（patch 时必须原样传回）：${baseRevision}` +
      `\n回滚点（.chery/backups/，最近在前）：\n` +
      (backups.length ? backups.join('\n') : '（无）') +
      `\n说明：不要回传完整配置；只提交目标资源的强类型 operations。` +
      `敏感 key 为 [REDACTED] 时会保留盘上原值，显式给出新值才会替换。`,
    hash: '',
  }
}

/** patch：检查 baseRevision，增量构造候选，全量校验后持久化并安排空闲重启。 */
function doPatch(baseRevision: string, operations: readonly ConfigOperation[]): SenseResult {
  const disk = readRawConfig()
  const applied = applyConfigOperations(disk, operations)
  if (!applied.ok) {
    return {
      content: `配置增量操作被拒绝，未落盘：\n${applied.errors.join('\n')}`,
      hash: '',
    }
  }
  const result = commitConfigCandidate({
    candidate: applied.candidate,
    expectedBaseRevision: baseRevision,
  })
  if (!result.ok) {
    const retry =
      result.kind === 'stale'
        ? `\n请重新调用 action="get" 获取最新配置与 baseRevision，重新核对后再提交。当前 revision：${result.currentRevision}`
        : '\n请按错误修正 operations 后重试；候选配置未写盘。'
    return {
      content: `配置候选被拒绝，未落盘：\n${[...result.errors, ...result.warnings].join('\n')}${retry}`,
      hash: '',
    }
  }
  return {
    content:
      `配置候选已通过完整校验并保存；候选修订 ${result.candidateRevisionId}，` +
      `新 baseRevision ${result.baseRevision}。旧配置已自动备份。` +
      (result.restart === 'manual'
        ? '当前没有守护进程，请手动重启后生效。'
        : result.restart === 'immediate'
          ? '当前没有运行中的会话任务，已安排立即受控重启。'
          : '已安排在所有运行中的会话任务结束后受控重启；不会中断当前任务。') +
      (result.warnings.length ? `\n警告：\n${result.warnings.join('\n')}` : ''),
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
        '可通过 config_manage(action="get") 查看当前 .chery/backups/ 回滚点；首次成功 action="patch" 后才会生成备份。',
      hash: '',
    }
  }
}

const configManageDescription = `管理 .chery/config.yaml 配置（配置管理核心角色 cheryNyxus 专用）。配置采用强类型增量候选流程（get 读 / patch 改 / rollback 恢复）。
⚠️ action 参数必填。配置操作取 get / patch / rollback；旧 action="save" 已停用；资产操作取 asset_get / asset_save / asset_archive：
1. action="get"：读取完整脱敏配置、baseRevision 和回滚点。任何配置变更的第一步，必须先调用。
2. action="patch" + baseRevision + operations：只提交目标 brain/role/preset/senseGroup 的强类型 put/remove 操作。服务端基于当前磁盘配置构造候选，全量校验通过后才写盘；revision 过期或任一校验失败均不落盘。成功后仅在所有会话任务空闲时受控重启。
3. action="rollback"（+ 可选 backup 文件名）：从 .chery/backups/ 恢复指定（或缺省最近）备份，撤销之前的保存。
4. asset_get/asset_save/asset_archive + assetPath：管理角色提示词、技能和规则文件。archive 会先检查当前引用并移动到 backups/assets，不做不可恢复删除；仍被引用时严格拒绝。
使用流程：先 get → 核对字段与稳定 id → 用 ask_user_question 向用户确认变更（含前后对比、影响范围）→ patch。不得猜测类型，不得回传完整配置。
禁止用 execute_command（cat/type/grep/head 等读取内容）或 write_file 直接读取/修改 .chery 配置（会被拦截，且绕过脱敏层）；获取 .chery 目录信息类命令（ls/dir/find/stat 列目录）不受影响。`

export default sense(
  'config_manage',
  configManageDescription,
  ConfigManageSchema,
  async (args): Promise<SenseResult> => {
    if (args.action === 'get') return doGet()
    if (args.action === 'patch') {
      if (!args.baseRevision || !args.operations) {
        return {
          content:
            '错误：config_manage action="patch" 需要 baseRevision 和 operations。\n' +
            '请先调用 action="get"，确认变更后原样传回 revision，并只提交目标资源操作。',
          hash: '',
        }
      }
      return doPatch(args.baseRevision, args.operations)
    }
    if (args.action === 'save') {
      return {
        content:
          '错误：config_manage action="save" 的全量配置写入已停用，未执行任何操作。\n' +
          '请重新调用 action="get" 获取 baseRevision，然后使用 action="patch" + 强类型 operations。',
        hash: '',
      }
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
        '  2. action="patch" + baseRevision + operations：提交强类型增量候选。\n' +
        '  3. action="rollback"（+ 可选 backup 文件名）：从 .chery/backups/ 恢复指定（或缺省最近）备份。\n' +
        '请先调用 config_manage(action="get") 获取当前配置。',
      hash: '',
    }
  },
  SupervisionLevel.smart,
)
