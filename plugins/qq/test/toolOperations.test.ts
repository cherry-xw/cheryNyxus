import { describe, expect, it } from 'vitest'
import { informationSchema, historySchema } from '../src/information.js'
import { convertQQToolGroups } from '../src/toolConversion.js'
import { createReplyTools } from '../src/replyTools.js'
describe('QQ consolidated tools', () => {
  it('rejects irrelevant information parameters and separates history', () => {
    expect(informationSchema.safeParse({ kind: 'history' }).success).toBe(false)
    expect(informationSchema.safeParse({ kind: 'file_url', folderId: 'x' }).success).toBe(false)
    expect(informationSchema.safeParse({ kind: 'member' }).success).toBe(false)
    expect(informationSchema.safeParse({ kind: 'file_url', fileId: 'x' }).success).toBe(true)
    expect(historySchema.safeParse({ source: 'platform', cursor: 'x' }).success).toBe(false)
  })
  it('maps selected actions without opening unrelated capabilities and keeps stricter levels', () => {
    expect(convertQQToolGroups({ test: ['qq_react:auto','qq_react:manual','qq_group_write_file:smart'] }).groups.test)
      .toEqual(['qq_interact.reaction:manual','qq_file_write.group:smart'])
  })
  it('exposes one callable interaction and non-callable action choices', () => {
    const tools = createReplyTools({ lookup: async () => ({}), reply: async () => ({}) })
    expect(tools.map(tool => tool.sense.definition.function.name)).toEqual(['qq_deliver_media','qq_interact'])
    const policy = tools[1]!.sense.operationPolicy!
    expect(policy.key({ action: 'reaction' })).toBe('qq_interact.reaction')
    expect(JSON.stringify(policy.definition(['qq_interact.reaction']))).not.toContain('"const":"voice"')
  })
})
