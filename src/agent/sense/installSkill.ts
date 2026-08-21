import { z } from 'zod'
import { sense, type SenseResult } from '@/core/sense'
import { SupervisionLevel } from '@/core/config'
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'fs'
import { join } from 'path'
import {
  createStaging,
  removeStaging,
  extractZipBuffer,
  skillsDir,
  stagingRoot,
  normalizeSkillFileName,
  parseGithubUrl,
  NAME_PATTERN,
} from '@/service/skill/importShared.js'
import { cloneRepo, ensureGitAvailable } from '@/service/skill/gitClone.js'
import { analyzeSkillStaging } from '@/service/skill/import.js'

/**
 * install_skill 感官：配置管理核心角色（cheryNyxus）专用，从 URL 安装技能到 .chery/skills/。
 *
 * 两阶段（stage → commit）：
 *   - stage：fetch URL → 三态分发（zip/git/manifest）→ /tmp 解压 → 候选列表
 *   - commit：据 selections cpSync 到 .chery/skills/ + 规范化 SKILL.md + 落 sourceUrl 追溯
 *
 * 三态确定性（规则 5）：按 URL 形状 + 内容魔数机器识别，不交 LLM 自由解析。
 * 监管 smart（写 .chery/ = prompt 注入面）。.chery/ 路径守卫豁免（GUARD_EXEMPT）。
 *
 * 详见 docs/agent/skill-install.md。
 */

const stageSchema = z.object({
  phase: z.literal('stage'),
  url: z
    .string()
    .describe(
      '技能来源 URL：zip 直链 / git 仓库（https|git@|ssh）/ manifest（YAML frontmatter 含 source）',
    ),
  branch: z.string().optional().describe('git 来源分支，缺省用默认分支'),
})

const commitSchema = z.object({
  phase: z.literal('commit'),
  stagingId: z.string().describe('stage 返回的 stagingId'),
  selections: z
    .array(
      z.object({
        name: z.string(),
        import: z.boolean().describe('是否安装该项（false 跳过 / true 覆盖安装）'),
      }),
    )
    .describe('逐项选择，据 ask_user_question 用户确认结果填'),
})

/** ZIP 魔数 PK。 */
function isZip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b
}

/** 从 markdown frontmatter 提取 source/branch（manifest 判定）。无 frontmatter 或无 source → 空。 */
function parseManifestSource(text: string): { source?: string; branch?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const kv: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const mm = line.match(/^(\w+)\s*:\s*(.+)$/)
    if (mm) kv[mm[1]!] = mm[2]!.trim().replace(/^["']|["']$/g, '')
  }
  return { source: kv.source, branch: kv.branch }
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * stage 核心：fetch → 三态分发 → /tmp staging → 候选。
 * depth 限制 manifest 递归（防无限循环，>1 抛错；manifest→zip/git/文件 仅允许 1 层）。
 */
async function doStage(
  url: string,
  branch: string | undefined,
  depth: number,
): Promise<SenseResult> {
  if (depth > 1)
    throw new Error('manifest 嵌套层数超限（source 指向的仍是 manifest？请指向 zip/git/文件）')

  // 嗅探 git URL
  let gitParsed: ReturnType<typeof parseGithubUrl> | undefined
  try {
    gitParsed = parseGithubUrl(url)
  } catch {
    gitParsed = undefined
  }
  const looksGit = !!gitParsed && /^((https?|ssh):\/\/|git@)/.test(url)

  const { id, dir } = createStaging()
  const raw = join(dir, '_raw')
  try {
    if (looksGit && gitParsed) {
      await ensureGitAvailable()
      const b = branch ?? gitParsed.branch
      await cloneRepo(gitParsed.gitUrl, raw, b ? { branch: b } : {})
    } else {
      const buf = await fetchBuffer(url)
      if (isZip(buf)) {
        extractZipBuffer(buf, raw)
      } else {
        const text = buf.toString('utf-8')
        const man = parseManifestSource(text)
        if (man.source && man.source !== url) {
          // manifest：递归 fetch source（深度 +1）
          removeStaging(id)
          return doStage(man.source, man.branch ?? branch, depth + 1)
        }
        // 单文件 SKILL.md：须有 frontmatter（否则非有效 skill 文件）
        if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) {
          throw new Error(
            '来源内容无法识别：非 zip / 非 git URL / 非 manifest（frontmatter 缺 source）/ 非 SKILL.md（缺 frontmatter）',
          )
        }
        mkdirSync(raw, { recursive: true })
        writeFileSync(join(raw, 'SKILL.md'), buf)
      }
    }
    const result = analyzeSkillStaging(id, raw, { sourceUrl: url })
    return {
      content:
        `已获取来源 ${url}，发现 ${result.candidates.length} 个候选技能：\n` +
        JSON.stringify(
          { stagingId: result.stagingId, candidates: result.candidates, sourceUrl: url },
          null,
          2,
        ) +
        `\n请用 ask_user_question 让用户逐项确认要安装哪些（conflict=true 项需明确覆盖意向），再用 phase="commit" + stagingId + selections 落盘。`,
      hash: '',
    }
  } catch (err) {
    removeStaging(id)
    throw err
  }
}

interface SkillManifestItem {
  name: string
  rawFolder: string
  description: string
  trigger?: string
  conflict: boolean
}
interface SkillManifest {
  kind: 'skill'
  sourceUrl?: string
  items: SkillManifestItem[]
}

function readStagingManifest(stagingId: string): SkillManifest {
  const p = join(stagingRoot(), stagingId, 'manifest.json')
  if (!existsSync(p))
    throw new Error(`暂存 manifest 不存在（stagingId=${stagingId}），请重新 stage`)
  return JSON.parse(readFileSync(p, 'utf-8')) as SkillManifest
}

/** commit：据 selections cpSync 到 .chery/skills/ + 规范化 + 落追溯 + 清 staging。 */
function doCommit(args: {
  stagingId: string
  selections: Array<{ name: string; import: boolean }>
}): SenseResult {
  const manifest = readStagingManifest(args.stagingId)
  const want = new Map(args.selections.map((s) => [s.name, s.import]))
  const imported: string[] = []
  const skipped: string[] = []
  for (const item of manifest.items) {
    if (want.get(item.name) === false) {
      skipped.push(item.name)
      continue
    }
    if (!NAME_PATTERN.test(item.name)) {
      throw new Error(`skill 名 "${item.name}" 非法（仅允许 [a-zA-Z0-9_-]）`)
    }
    const dest = join(skillsDir(), item.name)
    cpSync(item.rawFolder, dest, { recursive: true, force: true })
    normalizeSkillFileName(dest)
    if (manifest.sourceUrl) {
      writeFileSync(
        join(dest, '.chery-source.json'),
        JSON.stringify({ sourceUrl: manifest.sourceUrl, installedAt: new Date().toISOString() }),
        'utf-8',
      )
    }
    imported.push(item.name)
  }
  removeStaging(args.stagingId)
  return {
    content:
      `安装完成：${imported.length ? imported.join(', ') : '（未选任何项）'}` +
      (skipped.length ? `；跳过：${skipped.join(', ')}` : '') +
      `\n技能已落盘 .chery/skills/，下一轮对话 <skills> 段即可见。`,
    hash: '',
  }
}

const installDescription = `从 URL 安装技能到 .chery/skills/（配置管理核心角色 cheryNyxus 专用）。
两阶段调用：
1. phase="stage" + url（+ 可选 branch）：获取来源（zip 直链 / git 仓库 / manifest）到临时区，返回候选技能列表 + stagingId。
   支持三种来源（自动识别）：zip 压缩包、git 仓库 URL（https|git@|ssh）、manifest（YAML frontmatter 含 source 字段，指向真实 zip/git）。
2. 据 stage 返回的候选，用 ask_user_question 让用户逐项确认要装哪些（conflict=true 表示同名已存在，需确认覆盖），再用 phase="commit" + stagingId + selections 落盘。
返回结果含安装/跳过的技能名。装完下轮对话即生效。`

export default sense(
  'install_skill',
  installDescription,
  z.discriminatedUnion('phase', [stageSchema, commitSchema]),
  async (args): Promise<SenseResult> => {
    if (args.phase === 'stage') {
      return await doStage(args.url, args.branch, 0)
    }
    return doCommit(args)
  },
  SupervisionLevel.smart,
)
