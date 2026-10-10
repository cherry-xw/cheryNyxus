import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { RpcRouter } from '../message/router.js'
import { readConfigImage, getSavedBaseRevision, commitConfigCandidate } from '../config/commit.js'

const input = z.object({ preset: z.string().min(1).max(128) }).strict()
const saveInput = input
  .extend({
    scope: z.enum(['global', 'role']),
    content: z.string().max(100000),
    expectedContentRevision: z.string().min(1),
    expectedBaseRevision: z.string().min(1),
  })
  .strict()
const contentRevision = (content: string | Buffer) =>
  createHash('sha256').update(content).digest('hex')
function resolve(preset: string) {
  const image = readConfigImage()
  const selected = image.config.presets?.[preset]
  const role = selected && image.config.roles?.[selected.leader]
  if (!selected || !role) throw new Error('预设或主角色不存在')
  const root = path.resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
  const prompts = path.join(root, 'prompt')
  const globalPath = path.join(prompts, 'system.md')
  const rolePath = role.systemPrompt
    ? path.resolve(root, role.systemPrompt)
    : path.join(prompts, `preset-${selected.id || selected.leader}.md`)
  for (const file of [globalPath, rolePath]) {
    if (!file.startsWith(prompts + path.sep) || (file === globalPath && file === rolePath))
      throw new Error('提示词路径不允许编辑')
    let cursor = file
    while (cursor !== path.dirname(cursor)) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
        throw new Error('提示词路径不允许符号链接')
      cursor = path.dirname(cursor)
    }
  }
  if (rolePath === globalPath) throw new Error('角色提示词不能与全局文件相同')
  const sharedPresets = Object.entries(image.config.presets || {})
    .filter(
      ([, p]) =>
        p.leader === selected.leader ||
        (role.systemPrompt && image.config.roles?.[p.leader]?.systemPrompt === role.systemPrompt),
    )
    .map(([name]) => name)
  return { image, root, role, globalPath, rolePath, sharedPresets }
}
export function getPresetPrompts(preset: string) {
  const s = resolve(preset)
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  return {
    preset,
    baseRevision: getSavedBaseRevision(s.image),
    contentRevisions: {
      global: contentRevision(read(s.globalPath)),
      role: contentRevision(read(s.rolePath)),
    },
    global: read(s.globalPath),
    role: read(s.rolePath),
    sharedPresets: s.sharedPresets,
    roleConfigured: !!s.role.systemPrompt,
  }
}
export function savePresetPrompt(args: z.infer<typeof saveInput>) {
  const s = resolve(args.preset)
  if (getSavedBaseRevision(s.image) !== args.expectedBaseRevision)
    throw new Error('配置版本已变化，请重新读取提示词')
  const file = args.scope === 'global' ? s.globalPath : s.rolePath
  const original = fs.existsSync(file) ? fs.readFileSync(file) : undefined
  if (contentRevision(original ?? '') !== args.expectedContentRevision)
    throw new Error('提示词正文已被修改，请重新读取后保存')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.next`
  try {
    fs.writeFileSync(tmp, args.content, { mode: 0o600 })
    fs.renameSync(tmp, file)
    if (args.scope === 'role' && !s.role.systemPrompt) {
      const candidate = s.image.config
      s.role.systemPrompt = path.relative(s.root, file)
      const result = commitConfigCandidate({
        candidate,
        expectedBaseRevision: getSavedBaseRevision(),
      })
      if (!result.ok) throw new Error('角色提示词关联保存失败')
    }
  } catch (error) {
    if (original) fs.writeFileSync(file, original)
    else if (fs.existsSync(file)) fs.unlinkSync(file)
    throw error
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
  return { ...getPresetPrompts(args.preset), saved: true, runtimeRefreshRequired: true }
}
export function registerPresetPromptHandlers(router: RpcRouter) {
  for (const save of [false, true])
    router.registerExtension({
      method: save ? 'prompts.preset.save' : 'prompts.preset.get',
      request: save ? saveInput : input,
      response: z.unknown(),
      authorize: (ctx) => !ctx.credentialKind || ctx.credentialKind === 'control',
      handler: async (_ctx, args) =>
        save ? savePresetPrompt(saveInput.parse(args)) : getPresetPrompts(args.preset),
    })
}
