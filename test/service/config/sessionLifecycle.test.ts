import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AgentBuilder } from '@/agent/builder.js'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import {
  addPendingInput,
  createChat,
  deleteChat,
  getChat,
  getChatMetadata,
  listPendingInputs,
} from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import {
  getActiveChatEpoch,
  getActiveConfigRevision,
  getFrozenChatSnapshot,
  listChatEpochs,
} from '@/db/epoch.js'
import { upsertPendingInteraction } from '@/db/interaction.js'
import { upsertExecutionActiveRun } from '@/db/executionGraph.js'
import {
  createSpawnTask,
  finishSpawnTask,
  getSpawnTaskByChild,
} from '@/db/delivery.js'
import { ConfigApplyCoordinator } from '@/service/config/applyCoordinator.js'
import { registerRuntimeConfigAdapters } from '@/service/config/runtimeApply.js'
import {
  clearProcessRevisionCache,
  createConfigRevision,
  ensureCurrentConfigRevision,
} from '@/service/config/revision.js'
import { detectRetiredRoleIdentities } from '@/service/config/roleLifecycle.js'
import { treeBoundaryReason } from '@/service/config/treeBoundary.js'
import {
  activateChatRun,
  clearChatRuntime,
  ensureChat,
  getChatSelection,
  releaseChatRun,
} from '@/service/chat/runtime.js'
import { handleChatEpochList } from '@/service/chat/promptSnapshot.js'
import { captureRuntimeConfig, getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import type { HandlerContext } from '@/service/message/router.js'
import type { ConfigImage } from '@/service/config/impact.js'

const baseline = getAppliedRawConfig()
const chats: string[] = []
beforeAll(bootstrapAgentRuntime)
beforeEach(() => {
  const raw = structuredClone(baseline)
  raw.roles = {
    ...raw.roles,
    hot_a: { id: 'role-hottest-a', brain: 'mock_content', senseGroup: 'auto_senses' },
    hot_b: { id: 'role-hottest-b', brain: 'mock_content', senseGroup: 'auto_senses' },
  }
  raw.presets = {
    ...raw.presets,
    hot_a: { id: 'preset-hottest-a', leader: 'hot_a', roles: ['hot_a'] },
    hot_b: { id: 'preset-hottest-b', leader: 'hot_b', roles: ['hot_b'] },
  }
  replaceRuntimeConfig(raw)
  clearProcessRevisionCache()
  ensureCurrentConfigRevision()
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const id of chats.splice(0).reverse()) {
    clearChatRuntime(id)
    deleteChat(id)
  }
  replaceRuntimeConfig(baseline)
  clearProcessRevisionCache()
})
async function root(name = 'hot_a') {
  const id = randomUUID()
  chats.push(id)
  createChat(id, { preset: name, presetId: `preset-hottest-${name.at(-1)}` })
  await ensureChat(id)
  return id
}
function setup(change: (image: ConfigImage) => void) {
  const before: ConfigImage = { config: getAppliedRawConfig(), hooks: {} }
  const next = structuredClone(before)
  change(next)
  const engine = new ConfigApplyCoordinator(before)
  registerRuntimeConfigAdapters(engine, next)
  engine.submit(next)
  return engine
}

describe('tree semantic publication', () => {
  it('waits for durable running work and preserves a deliberately paused run during adoption', async () => {
    const id = await root()
    const runId = randomUUID()
    const status = (value: 'waiting' | 'paused') =>
      upsertExecutionActiveRun({
        chatId: id,
        rootChatId: id,
        runId,
        status: value,
      })
    status('waiting')
    const epoch = getActiveChatEpoch(id)!
    const engine = setup((image) => {
      image.config.roles!.hot_a!.skills = []
    })
    await engine.retry()
    expect(engine.getState().status).toBe('pending')
    expect(getActiveChatEpoch(id)!.epochId).toBe(epoch.epochId)
    status('paused')
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(
      getSoulDb().prepare('SELECT status FROM execution_active_runs WHERE run_id = ?').get(runId),
    ).toEqual({ status: 'paused' })
    expect(getChat(id)!.lifecycle).toBe('active')
  })
  it('keeps active child and unrelated root on their epochs until the affected tree drains', async () => {
    const a = await root()
    const b = await root('hot_b')
    const child = randomUUID()
    chats.push(child)
    createChat(child, { type: 'hot_a', roleId: 'role-hottest-a' }, a)
    const oldBuilder = await ensureChat(child)
    activateChatRun(child, 'live-child')
    const oldEpoch = getActiveChatEpoch(a)!
    const otherEpoch = getActiveChatEpoch(b)!
    const oldConfig = captureRuntimeConfig()
    const engine = setup((image) => {
      image.config.roles!.hot_a!.brain = 'mock_auto'
    })
    await engine.retry()
    expect(engine.getState().status).toBe('pending')
    expect(captureRuntimeConfig()).toBe(oldConfig)
    expect(await ensureChat(child)).toBe(oldBuilder)
    await handleChatEpochList({} as HandlerContext, { chatId: a })
    expect(getActiveChatEpoch(a)!.epochId).toBe(oldEpoch.epochId)
    expect(getChat(child)!.lifecycle).toBe('active')
    releaseChatRun(child, 'live-child')
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getActiveChatEpoch(a)!.epochId).not.toBe(oldEpoch.epochId)
    expect(getActiveChatEpoch(child)!.epochId).toBe(getActiveChatEpoch(a)!.epochId)
    expect(getChatSelection(child)!.brain).toBe('mock_auto')
    expect(getChat(child)!.lifecycle).toBe('active')
    await ensureChat(b)
    expect(getActiveChatEpoch(b)!.epochId).toBe(otherEpoch.epochId)
    expect(getActiveConfigRevision()!.revisionId).toBe(ensureCurrentConfigRevision().revisionId)
    expect(getFrozenChatSnapshot(oldEpoch.epochId, child)!.runtime!.brain).toBe('mock_content')
  })

  it.each(['approval', 'question'] as const)(
    'preserves pending %s and reports its waiting reason',
    async (kind) => {
      const id = await root()
      const interactionId = randomUUID()
      upsertPendingInteraction({ interactionId, chatId: id, kind, payload: {} })
      const epoch = getActiveChatEpoch(id)!
      const engine = setup((image) => {
        image.config.roles!.hot_a!.skills = []
      })
      await engine.retry()
      expect(engine.getState().impacts[0]!.reason).toContain('问题或审批')
      expect(getActiveChatEpoch(id)!.epochId).toBe(epoch.epochId)
      expect(
        getSoulDb()
          .prepare('SELECT status FROM interactions WHERE interaction_id = ?')
          .get(interactionId),
      ).toEqual({ status: 'pending' })
      getSoulDb()
        .prepare("UPDATE interactions SET status = 'completed' WHERE interaction_id = ?")
        .run(interactionId)
      await engine.retry()
      expect(engine.getState().status).toBe('applied')
    },
  )

  it('keeps queued inputs once and migrates their epoch with the frozen prompt contract', async () => {
    const id = await root()
    const builder = await ensureChat(id)
    const inputId = randomUUID(),
      messageId = randomUUID(),
      commandId = randomUUID()
    const oldEpoch = getActiveChatEpoch(id)!
    addPendingInput({
      inputId,
      messageId,
      commandId,
      chatId: id,
      content: 'one input',
      queueSequence: 1,
      state: 'queued',
      acceptedAt: Date.now(),
      epochId: oldEpoch.epochId,
    })
    builder.enqueueInput('one input', { inputId, messageId, commandId })
    const engine = setup((image) => {
      image.config.roles!.hot_a!.skills = []
    })
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    const replacement = await ensureChat(id)
    expect(
      replacement.getPendingInputs().filter((input) => input.inputId === inputId),
    ).toHaveLength(1)
    expect(listPendingInputs(id)[0]!.epoch_id).toBe(getActiveChatEpoch(id)!.epochId)
    expect(getChatMetadata(id).skillFilter).toEqual({ skills: [] })
  })

  it('does not retire ordinary role edits or rotate for display and schedule changes', async () => {
    const id = await root()
    const before = getAppliedRawConfig()
    const revision = createConfigRevision({ raw: before, source: 'structured' })
    const after = structuredClone(before)
    after.roles!.hot_a!.description = 'new description'
    after.roles!.hot_a!.avatar = 'new-avatar'
    after.presets!.hot_a!.schedule = { cron: '0 0 * * *', task: 'later', enabled: false }
    expect(createConfigRevision({ raw: after, source: 'structured' }).revisionId).toBe(
      revision.revisionId,
    )
    const changed = structuredClone(after)
    changed.roles!.hot_a!.brain = 'mock_auto'
    expect(detectRetiredRoleIdentities(before.roles as never, changed.roles as never).ids).toEqual(
      [],
    )
    const engine = setup((image) => {
      image.config.roles!.hot_a!.description = 'display'
    })
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(listChatEpochs(id)).toHaveLength(1)
  })

  it('waits for spawned work before deleting and archives only the deleted preset tree', async () => {
    const a = await root(),
      b = await root('hot_b')
    const child = randomUUID()
    chats.push(child)
    createChat(child, { type: 'hot_a', roleId: 'role-hottest-a' }, a)
    const task = createSpawnTask({
      childChatId: child,
      parentChatId: a,
      type: 'hot_a',
      prompt: 'finish this',
      brain: 'mock_content',
      senseGroup: 'auto_senses',
    })
    const engine = setup((image) => {
      delete image.config.presets!.hot_a
    })
    await engine.retry()
    expect(engine.getState().status).toBe('pending')
    expect(getChat(child)!.lifecycle).toBe('active')
    finishSpawnTask(task.taskId)
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getChat(a)!.lifecycle).toBe('archived')
    expect(getChat(child)!.lifecycle).toBe('archived')
    expect(getSpawnTaskByChild(child)!.status).toBe('finished')
    expect(getChat(b)!.lifecycle).toBe('active')
  })

  it('renames stable identities and their preset references in one publication', async () => {
    const id = await root()
    const engine = setup((image) => {
      image.config.roles!.hot_renamed = image.config.roles!.hot_a!
      delete image.config.roles!.hot_a
      image.config.presets!.hot_a!.leader = 'hot_renamed'
      image.config.presets!.hot_a!.roles = ['hot_renamed']
    })
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getChatMetadata(id)).toMatchObject({
      roleId: 'role-hottest-a',
      type: 'hot_renamed',
      spawnTypes: ['hot_renamed'],
    })
    expect(getChat(id)!.lifecycle).toBe('active')
  })

  it('rolls back metadata, revision and epoch when replacement initialization fails', async () => {
    const id = await root()
    const oldConfig = captureRuntimeConfig()
    const oldEpoch = getActiveChatEpoch(id)!
    const oldMetadata = getChatMetadata(id)
    const oldActive = ensureCurrentConfigRevision()
    const initialize = vi.spyOn(AgentBuilder.prototype, 'init').mockImplementationOnce(() => {
      throw new Error('injected replacement initialization failure')
    })
    const engine = setup((image) => {
      image.config.roles!.hot_a!.skills = []
    })
    await engine.retry()
    expect(engine.getState().status).toBe('failed')
    expect(captureRuntimeConfig()).toBe(oldConfig)
    expect(getActiveChatEpoch(id)!.epochId).toBe(oldEpoch.epochId)
    expect(getChatMetadata(id)).toEqual(oldMetadata)
    expect(ensureCurrentConfigRevision().revisionId).toBe(oldActive.revisionId)
    expect(getChatSelection(id)!.senseGroup).toBe('auto_senses')
    expect(treeBoundaryReason(id)).toBeUndefined()
    initialize.mockRestore()
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
  })

  it('reloads global prompt resources only at the affected tree boundary', async () => {
    const id = await root()
    const oldEpoch = getActiveChatEpoch(id)!
    const frozen = getFrozenChatSnapshot(oldEpoch.epochId, id)!
    const filename = path.join(captureRuntimeConfig().global.prompts_dir, 'system.md')
    const original = fs.existsSync(filename) ? fs.readFileSync(filename) : undefined
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true })
      fs.writeFileSync(filename, 'hot prompt boundary marker')
      activateChatRun(id, 'prompt-run')
      const engine = setup((image) => {
        image.assets = { 'prompt/system.md': 'changed-prompt-hash' }
      })
      await engine.retry()
      expect(engine.getState().status).toBe('pending')
      expect(getActiveChatEpoch(id)!.epochId).toBe(oldEpoch.epochId)
      releaseChatRun(id, 'prompt-run')
      await engine.retry()
      expect(engine.getState().status).toBe('applied')
      expect(getFrozenChatSnapshot(getActiveChatEpoch(id)!.epochId, id)!.systemPrompt).toContain(
        'hot prompt boundary marker',
      )
      expect(getFrozenChatSnapshot(oldEpoch.epochId, id)!.systemPrompt).toBe(frozen.systemPrompt)
    } finally {
      if (original) fs.writeFileSync(filename, original)
      else if (fs.existsSync(filename)) fs.unlinkSync(filename)
    }
  })
})
