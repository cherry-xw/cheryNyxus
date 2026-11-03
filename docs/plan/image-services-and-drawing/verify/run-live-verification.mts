import { createRequire } from 'node:module'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import type { DrawingIntent, MessagePart } from '@chery/protocol'

const root = '/home/chery/dev/cheryClaw'
const require = createRequire(join(root, 'apps/backend/package.json'))
const yaml = require('js-yaml')
const outDir = '/tmp/opencode/image-services-live-20261102'
const sandboxDir = join(outDir, 'chery-sandbox')
rmSync(sandboxDir, { recursive: true, force: true })
mkdirSync(join(sandboxDir, '.chery', 'data'), { recursive: true })
writeFileSync(
  join(sandboxDir, '.chery', 'model-catalog.yaml'),
  readFileSync(join(root, 'apps/backend/.chery.template/model-catalog.yaml')),
)
process.env.CHERY_DIR = sandboxDir

const prodConfig = yaml.load(readFileSync('/home/chery/docker/cherynyxus/qqbot-data/.chery/config.yaml', 'utf8')) as any
const apiKey = prodConfig.llm.brain.minimax.key as string
process.env.LIVE_TEST_API_KEY = apiKey

const baseConfig = {
  global: { supervision: 'smart' },
  files: {
    imageGeneration: { defaultCount: 1 },
  },
  llm: {
    brain: {
      main: {
        provider: 'openai',
        protocol: 'openai-chat-completions',
        url: 'https://ai.xcherry.top/v1',
        model: 'gpt-5.6-sol',
        key: '$LIVE_TEST_API_KEY',
        contextLimit: 256000,
        capabilities: {
          toolCall: true,
        },
      },
    },
  },
  sense_groups: {
    draw_group: [
      'file_svc_openai_images_image_generate',
      'file_svc_openai_images_image_reference',
      'file_svc_openai_images_image_edit',
      'file_svc_openai_responses_image_generate',
      'file_svc_openai_responses_image_reference',
      'file_svc_openai_responses_image_edit',
    ],
  },
  roles: {
    leader: {
      brain: 'main',
      senseGroup: 'draw_group',
      fileCapabilities: {
        'image.generate': { mode: 'tool', targetId: 'file_svc_openai_images_image_generate' },
        'image.reference': { mode: 'tool', targetId: 'file_svc_openai_images_image_reference' },
        'image.edit': { mode: 'tool', targetId: 'file_svc_openai_images_image_edit' },
      },
    },
  },
  presets: {
    default: {
      leader: 'leader',
      roles: ['leader'],
    },
  },
  file_services: {
    svc_openai_images: {
      name: 'OpenAI Images Live',
      enabled: true,
      adapter: 'openai-images',
      connection: {
        baseUrl: 'https://ai.xcherry.top',
        model: 'gpt-image-2',
        authType: 'bearer',
        keyRef: '$LIVE_TEST_API_KEY',
      },
      operations: ['image.generate', 'image.reference', 'image.edit'],
      defaults: { size: '1024x1024', quality: 'low', output_format: 'png' },
    },
    svc_openai_responses: {
      name: 'OpenAI Responses Image Live',
      enabled: true,
      adapter: 'openai-responses-image',
      connection: {
        baseUrl: 'https://ai.xcherry.top',
        model: 'gpt-5.6-sol',
        authType: 'bearer',
        keyRef: '$LIVE_TEST_API_KEY',
      },
      operations: ['image.generate', 'image.reference', 'image.edit'],
      defaults: { image_model: 'gpt-image-2', size: '1024x1024', quality: 'low', output_format: 'png' },
    },
  },
}

writeFileSync(join(sandboxDir, '.chery', 'config.yaml'), yaml.dump(baseConfig), 'utf8')
writeFileSync(join(sandboxDir, '.env'), `LIVE_TEST_API_KEY=${apiKey}\n`, { mode: 0o600 })

const config = (await import(join(root, 'apps/backend/src/utils/config.ts'))).default
const { createChat } = await import(join(root, 'apps/backend/src/db/chat.ts'))
const { getAssetStore } = await import(join(root, 'apps/backend/src/service/media/store.ts'))
const { fileAccessForChat } = await import(join(root, 'apps/backend/src/service/media/access.ts'))
const { resolveImageOutput } = await import(join(root, 'apps/backend/src/service/fileServices/imageOutput.ts'))
const { runFileOperation } = await import(join(root, 'apps/backend/src/service/fileServices/operations.ts'))
const { createDrawingRound, getDrawingTask, listDrawingTasks, finalizeDrawing, drawingContinuation } = await import(join(root, 'apps/backend/src/service/fileServices/drawings.ts'))
const { handleFileServiceHttp } = await import(join(root, 'apps/backend/src/service/fileServices/http.ts'))

const ownerId = 'manager-internal'
const chatId = `live-drawing-${randomUUID()}`
createChat(chatId, { preset: 'default', fileOwnerId: ownerId })

async function callHttp(pathname: string, body: unknown, user = ownerId) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: pathname,
    headers: { 'content-type': 'application/json' },
  }) as IncomingMessage
  let status = 200
  const chunks: Buffer[] = []
  const res = {
    writeHead(code: number) { status = code; return this },
    end(chunk?: string | Buffer) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); return this },
  } as unknown as ServerResponse
  await handleFileServiceHttp(req, res, user)
  return { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}

const evidence: Record<string, unknown> = {
  executedAt: new Date().toISOString(),
  chatId,
  ownerId,
  steps: {},
}

// Step 0: Verify empty drawing list and foreign owner 403
const emptyRes = await callHttp('/api/file-services/drawings', { chatId })
assert.equal(emptyRes.status, 200)
assert.deepEqual(emptyRes.body, { tasks: [] })
const foreignRes = await callHttp('/api/file-services/drawings', { chatId }, 'cherynyxus-qq-module')
assert.equal(foreignRes.status, 403)
assert.equal(foreignRes.body.error.code, 'file.permission_denied')
;(evidence.steps as any).step0_http_permissions = {
  ownChatStatus: emptyRes.status,
  foreignOwnerStatus: foreignRes.status,
  foreignOwnerError: foreignRes.body.error,
}
console.log('Step 0 passed: HTTP drawings list 200 & foreign owner 403')

// Step 1: Round 1 - Multi-image generation (desiredCount: 2) via svc_openai_images (gpt-image-2)
const outPlan1 = resolveImageOutput({
  service: config.file_services!.svc_openai_images!,
  operation: 'image.generate',
  desiredCount: 2,
  params: { size: '1024x1024', quality: 'low', output_format: 'png' },
})
assert.equal(outPlan1.availability, 'available')
assert.equal(outPlan1.count.effectiveCount, 2)

const intent1: DrawingIntent = {
  serviceId: 'svc_openai_images',
  operation: 'image.generate',
  desiredCount: 2,
  params: { size: '1024x1024', quality: 'low', output_format: 'png' },
  configRevision: outPlan1.configRevision,
}

const round1 = createDrawingRound({
  chatId,
  ownerId,
  inputId: `in-r1-${randomUUID()}`,
  messageId: `msg-r1-${randomUUID()}`,
  feedback: 'Draw a minimal geometric icon of a blue hexagon on a plain white background',
  intent: intent1,
  parts: [{ partId: 'p1', type: 'text', text: 'Draw a minimal geometric icon of a blue hexagon on a plain white background' }],
})

const op1 = await runFileOperation({
  serviceId: 'svc_openai_images',
  operation: 'image.generate',
  chatId,
  ownerId,
  requestId: `req-r1-${randomUUID()}`,
  assets: [],
  params: { ...intent1.params, prompt: 'Draw a minimal geometric icon of a blue hexagon on a plain white background' },
  drawingRoundId: round1.roundId,
})

assert.ok(['succeeded', 'partial'].includes(op1.executionStatus))
assert.equal(op1.deliveryStatus, 'saved')
const taskAfterR1 = getDrawingTask(round1.taskId, chatId, ownerId)
assert.equal(taskAfterR1.rounds.length, 1)
assert.ok(taskAfterR1.rounds[0]!.candidates.length >= 1)

const cand1 = taskAfterR1.rounds[0]!.candidates[0]!
const readCand1 = await getAssetStore().read(cand1.assetId, fileAccessForChat(chatId, ownerId), cand1.assetVersionId)
assert.ok(readCand1.data.byteLength > 1000)

const r1CandidateEvidence = []
for (const c of taskAfterR1.rounds[0]!.candidates) {
  const r = await getAssetStore().read(c.assetId, fileAccessForChat(chatId, ownerId), c.assetVersionId)
  r1CandidateEvidence.push({
    candidateId: c.candidateId,
    assetId: c.assetId,
    assetVersionId: c.assetVersionId,
    bytes: r.data.byteLength,
    sha256: createHash('sha256').update(r.data).digest('hex'),
  })
}

;(evidence.steps as any).step1_round1_multi_image = {
  taskId: round1.taskId,
  roundId: round1.roundId,
  operationId: op1.operationId,
  executionStatus: op1.executionStatus,
  deliveryStatus: op1.deliveryStatus,
  error: op1.error,
  imageCount: op1.imageCount,
  receivedImageCount: op1.receivedImageCount,
  savedImageCount: op1.savedImageCount,
  reportedFailedImageCount: op1.reportedFailedImageCount,
  candidates: r1CandidateEvidence,
}
console.log('Step 1 passed: Round 1 executionStatus:', op1.executionStatus, 'savedImageCount:', op1.savedImageCount, 'candidates:', r1CandidateEvidence.length)

// Step 2: Round 2 - Select candidate 1 and submit feedback modification (image.edit)
const refAssetPart: MessagePart = {
  partId: `ref-${cand1.candidateId}`,
  type: 'asset',
  assetId: cand1.assetId,
  assetVersionId: cand1.assetVersionId,
  variant: 'original',
  usage: 'content',
  mimeType: readCand1.asset.mimeType,
  byteLength: readCand1.data.byteLength,
}

const outPlan2 = resolveImageOutput({
  service: config.file_services!.svc_openai_images!,
  operation: 'image.edit',
  desiredCount: 1,
  params: { size: '1024x1024', quality: 'low', output_format: 'png' },
  inputImages: 1,
})
assert.equal(outPlan2.availability, 'available')
assert.equal(outPlan2.count.effectiveCount, 1)

const intent2: DrawingIntent = {
  serviceId: 'svc_openai_images',
  operation: 'image.edit',
  desiredCount: 1,
  params: { size: '1024x1024', quality: 'low', output_format: 'png' },
  configRevision: outPlan2.configRevision,
  taskId: round1.taskId,
  sourceCandidateId: cand1.candidateId,
}

const msgIdR2 = `msg-r2-${randomUUID()}`
getAssetStore().attachOwned([refAssetPart], fileAccessForChat(chatId, ownerId), 'message', msgIdR2)

const round2 = createDrawingRound({
  chatId,
  ownerId,
  inputId: `in-r2-${randomUUID()}`,
  messageId: msgIdR2,
  feedback: 'Change the blue hexagon to a warm orange hexagon and add a small gold star in the center',
  intent: intent2,
  parts: [
    refAssetPart,
    { partId: 'p2', type: 'text', text: 'Change the blue hexagon to a warm orange hexagon and add a small gold star in the center' },
  ],
})

const op2 = await runFileOperation({
  serviceId: 'svc_openai_images',
  operation: 'image.edit',
  chatId,
  ownerId,
  requestId: `req-r2-${randomUUID()}`,
  assets: [{ assetId: cand1.assetId, assetVersionId: cand1.assetVersionId }],
  params: { ...intent2.params, prompt: 'Change the blue hexagon to a warm orange hexagon and add a small gold star in the center' },
  drawingRoundId: round2.roundId,
})

assert.equal(op2.executionStatus, 'succeeded')
assert.equal(op2.deliveryStatus, 'saved')
assert.equal(op2.savedImageCount, 1)
const taskAfterR2 = getDrawingTask(round1.taskId, chatId, ownerId)
assert.equal(taskAfterR2.rounds.length, 2)
const candR2 = taskAfterR2.rounds[1]!.candidates[0]!
const readCandR2 = await getAssetStore().read(candR2.assetId, fileAccessForChat(chatId, ownerId), candR2.assetVersionId)

;(evidence.steps as any).step2_round2_edit_candidate = {
  roundId: round2.roundId,
  sourceCandidateId: cand1.candidateId,
  operationId: op2.operationId,
  executionStatus: op2.executionStatus,
  deliveryStatus: op2.deliveryStatus,
  savedImageCount: op2.savedImageCount,
  newCandidate: {
    candidateId: candR2.candidateId,
    assetId: candR2.assetId,
    assetVersionId: candR2.assetVersionId,
    bytes: readCandR2.data.byteLength,
    sha256: createHash('sha256').update(readCandR2.data).digest('hex'),
  },
}
console.log('Step 2 passed: Round 2 edited candidate 1 -> new candidate:', candR2.candidateId)

// Step 3: User Finalize on Round 2 candidate + idempotency + 409 conflict check
const finReqId = `fin-${randomUUID()}`
const finRes1 = await callHttp('/api/file-services/drawing-finalize', {
  chatId,
  taskId: round1.taskId,
  candidateId: candR2.candidateId,
  expectedSelectionRevision: taskAfterR2.selectionRevision,
  requestId: finReqId,
})
assert.equal(finRes1.status, 200)
assert.equal(finRes1.body.finalCandidateId, candR2.candidateId)
assert.equal(finRes1.body.selectionRevision, taskAfterR2.selectionRevision + 1)

// Idempotent retry with same requestId
const finResRetry = await callHttp('/api/file-services/drawing-finalize', {
  chatId,
  taskId: round1.taskId,
  candidateId: candR2.candidateId,
  expectedSelectionRevision: taskAfterR2.selectionRevision,
  requestId: finReqId,
})
assert.equal(finResRetry.status, 200)
assert.equal(finResRetry.body.selectionRevision, finRes1.body.selectionRevision)

// Stale revision conflict (dual-window conflict)
const finResConflict = await callHttp('/api/file-services/drawing-finalize', {
  chatId,
  taskId: round1.taskId,
  candidateId: cand1.candidateId,
  expectedSelectionRevision: taskAfterR2.selectionRevision,
  requestId: `fin-conflict-${randomUUID()}`,
})
assert.equal(finResConflict.status, 409)
assert.equal(finResConflict.body.error.code, 'file.state_conflict')

;(evidence.steps as any).step3_finalize_and_conflict = {
  finalizedCandidateId: finRes1.body.finalCandidateId,
  newSelectionRevision: finRes1.body.selectionRevision,
  idempotentRetryStatus: finResRetry.status,
  staleConflictStatus: finResConflict.status,
  staleConflictError: finResConflict.body.error,
}
console.log('Step 3 passed: Finalized candidate + idempotency + 409 conflict verified')

// Step 4: Round 3 via openai-responses-image (gpt-5.6-sol + image_model: gpt-image-2) after finalize, verifying previous finalize is NOT overwritten
const outPlan3 = resolveImageOutput({
  service: config.file_services!.svc_openai_responses!,
  operation: 'image.generate',
  desiredCount: 1,
  params: { image_model: 'gpt-image-2', size: '1024x1024', quality: 'low', output_format: 'png' },
})
assert.equal(outPlan3.availability, 'available')
assert.equal(outPlan3.imageModel, 'gpt-image-2')

const intent3: DrawingIntent = {
  serviceId: 'svc_openai_responses',
  operation: 'image.generate',
  desiredCount: 1,
  params: { image_model: 'gpt-image-2', size: '1024x1024', quality: 'low', output_format: 'png' },
  configRevision: outPlan3.configRevision,
  taskId: round1.taskId,
}

const round3 = createDrawingRound({
  chatId,
  ownerId,
  inputId: `in-r3-${randomUUID()}`,
  messageId: `msg-r3-${randomUUID()}`,
  feedback: 'Generate an image of a minimal green circle icon on a white background',
  intent: intent3,
  parts: [{ partId: 'p3', type: 'text', text: 'Generate an image of a minimal green circle icon on a white background' }],
})

const op3 = await runFileOperation({
  serviceId: 'svc_openai_responses',
  operation: 'image.generate',
  chatId,
  ownerId,
  requestId: `req-r3-${randomUUID()}`,
  assets: [],
  params: { ...intent3.params, prompt: 'Generate an image of a minimal green circle icon on a white background' },
  drawingRoundId: round3.roundId,
})

console.log('op3 result:', op3.executionStatus, op3.deliveryStatus, op3.error)
assert.equal(op3.executionStatus, 'succeeded')
assert.equal(op3.deliveryStatus, 'saved')
assert.equal(op3.savedImageCount, 1)
const taskAfterR3 = getDrawingTask(round1.taskId, chatId, ownerId)
assert.equal(taskAfterR3.rounds.length, 3)
// Previous user finalize must still be candR2.candidateId!
assert.equal(taskAfterR3.finalCandidateId, candR2.candidateId)
const candR3 = taskAfterR3.rounds[2]!.candidates[0]!
const readCandR3 = await getAssetStore().read(candR3.assetId, fileAccessForChat(chatId, ownerId), candR3.assetVersionId)
const refPartR3: MessagePart = {
  partId: `ref-${candR3.candidateId}`,
  type: 'asset',
  assetId: candR3.assetId,
  assetVersionId: candR3.assetVersionId,
  variant: 'original',
  usage: 'content',
  mimeType: readCandR3.asset.mimeType,
  byteLength: readCandR3.data.byteLength,
}
const msgIdR4 = `msg-r4-${randomUUID()}`
getAssetStore().attachOwned([refPartR3], fileAccessForChat(chatId, ownerId), 'message', msgIdR4)
const outPlan4 = resolveImageOutput({
  service: config.file_services!.svc_openai_responses!,
  operation: 'image.edit',
  desiredCount: 1,
  params: { image_model: 'gpt-image-2', size: '1024x1024', quality: 'low', output_format: 'png' },
  inputImages: 1,
})
const round4 = createDrawingRound({
  chatId,
  ownerId,
  inputId: `in-r4-${randomUUID()}`,
  messageId: msgIdR4,
  feedback: 'Add a tiny white dot inside the green circle',
  intent: {
    serviceId: 'svc_openai_responses',
    operation: 'image.edit',
    desiredCount: 1,
    params: { image_model: 'gpt-image-2', size: '1024x1024', quality: 'low', output_format: 'png' },
    configRevision: outPlan4.configRevision,
    taskId: round1.taskId,
    sourceCandidateId: candR3.candidateId,
  },
  parts: [refPartR3, { partId: 'p4', type: 'text', text: 'Add a tiny white dot inside the green circle' }],
})
const cont3 = drawingContinuation(round4, config.file_services!.svc_openai_responses!)
assert.ok(cont3 && typeof cont3.responseId === 'string' && cont3.responseId.startsWith('resp_'))

// Public HTTP response must strip providerContinuation
const listResAfterR3 = await callHttp('/api/file-services/drawings', { chatId })
assert.equal(listResAfterR3.status, 200)
assert.equal(JSON.stringify(listResAfterR3.body).includes('providerContinuation'), false)

;(evidence.steps as any).step4_responses_image_and_finalize_preservation = {
  roundId: round3.roundId,
  operationId: op3.operationId,
  remoteJobId: op3.remoteJobId,
  executionStatus: op3.executionStatus,
  deliveryStatus: op3.deliveryStatus,
  savedImageCount: op3.savedImageCount,
  preservedFinalCandidateId: taskAfterR3.finalCandidateId,
  hasPrivateContinuationInDb: Boolean(cont3?.responseId),
  leakedContinuationInHttp: JSON.stringify(listResAfterR3.body).includes('providerContinuation'),
  newCandidate: {
    candidateId: candR3.candidateId,
    assetId: candR3.assetId,
    assetVersionId: candR3.assetVersionId,
    bytes: readCandR3.data.byteLength,
    sha256: createHash('sha256').update(readCandR3.data).digest('hex'),
  },
}
console.log('Step 4 passed: openai-responses-image generated candidate + preserved finalCandidateId + continuation verified')

writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
console.log('All live verification steps completed! Evidence saved to', join(outDir, 'evidence.json'))
