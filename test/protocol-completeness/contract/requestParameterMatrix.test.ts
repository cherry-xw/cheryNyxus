import { describe, expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import { requestSchemas } from '@/service/message/schemas'

interface ValueCase {
  label: string
  value: unknown
}

interface MethodMatrix {
  method: Method
  valid: ValueCase[]
  invalid: ValueCase[]
}

const value = (label: string, input: unknown): ValueCase => ({ label, value: input })

const chatMatrices: MethodMatrix[] = [
  {
    method: Method.CHAT_CREATE,
    valid: [
      value('preset source', { preset: 'default' }),
      value('explicit runtime source', { brain: 'mock', senseGroup: 'tools', mcpServers: [] }),
    ],
    invalid: [
      value('missing runtime source', {}),
      value('wrong brain type', { brain: 1 }),
      value('empty preset', { preset: '' }),
      value('conflicting preset and runtime', { preset: 'default', brain: 'mock' }),
    ],
  },
  {
    method: Method.CHAT_LIST,
    valid: [
      value('stage scope', { scope: 'stage' }),
      value('preset id scope', { scope: 'preset', presetId: 'preset-1' }),
      value('history preview', { scope: 'history', includePreview: true }),
    ],
    invalid: [
      value('missing scope', {}),
      value('unknown scope', { scope: 'all' }),
      value('preset scope without identity', { scope: 'preset' }),
    ],
  },
  {
    method: Method.CHAT_ROUTE_SUGGEST,
    valid: [value('bounded draft', { presetId: 'preset-1', draft: 'continue', requestVersion: 0 })],
    invalid: [
      value('blank draft', { presetId: 'preset-1', draft: '   ', requestVersion: 0 }),
      value('negative version', { presetId: 'preset-1', draft: 'continue', requestVersion: -1 }),
      value('fractional version', { presetId: 'preset-1', draft: 'continue', requestVersion: 1.5 }),
    ],
  },
  {
    method: Method.CHAT_DELETE,
    valid: [value('chat identity', { chatId: 'chat-1' })],
    invalid: [value('missing identity', {}), value('empty identity', { chatId: '' })],
  },
  {
    method: Method.CHAT_BRANCH_PREVIEW,
    valid: [value('branch anchor', { rootChatId: 'root-1', anchorNodeId: 'node-1' })],
    invalid: [value('missing anchor', { rootChatId: 'root-1' }), value('wrong anchor type', { rootChatId: 'root-1', anchorNodeId: 1 })],
  },
  {
    method: Method.CHAT_BRANCH_CREATE,
    valid: [
      value('continuation branch', {
        rootChatId: 'root-1',
        anchorNodeId: 'node-1',
        branchType: 'continuation',
        prompt: 'continue here',
        commandId: 'command-1',
        clientMessageId: 'client-1',
        messageId: 'message-1',
      }),
    ],
    invalid: [
      value('unknown branch type', {
        rootChatId: 'root-1', anchorNodeId: 'node-1', branchType: 'fork', prompt: 'x',
        commandId: 'command-1', clientMessageId: 'client-1', messageId: 'message-1',
      }),
      value('blank prompt', {
        rootChatId: 'root-1', anchorNodeId: 'node-1', branchType: 'detail', prompt: ' ',
        commandId: 'command-1', clientMessageId: 'client-1', messageId: 'message-1',
      }),
    ],
  },
  {
    method: Method.CHAT_BRANCH_ACTIVATE,
    valid: [value('activate branch', { branchId: 'branch-1', commandId: 'command-1' })],
    invalid: [value('missing command', { branchId: 'branch-1' }), value('empty branch', { branchId: '', commandId: 'command-1' })],
  },
  {
    method: Method.CHAT_ABORT_TASK,
    valid: [value('abort task', { taskId: 'task-1', commandId: 'command-1' })],
    invalid: [value('missing task', { commandId: 'command-1' }), value('empty command', { taskId: 'task-1', commandId: '' })],
  },
  {
    method: Method.CHAT_CONTEXT_USAGE,
    valid: [value('chat identity', { chatId: 'chat-1' })],
    invalid: [value('empty chat identity', { chatId: '' })],
  },
  {
    method: Method.CHAT_PROMPT_SNAPSHOT,
    valid: [value('current epoch', { chatId: 'chat-1' }), value('historical epoch', { chatId: 'chat-1', epochId: 'epoch-1' })],
    invalid: [value('missing chat', { epochId: 'epoch-1' }), value('empty epoch', { chatId: 'chat-1', epochId: '' })],
  },
  {
    method: Method.CHAT_EPOCH_LIST,
    valid: [value('chat identity', { chatId: 'chat-1' })],
    invalid: [value('wrong identity type', { chatId: 1 }), value('empty identity', { chatId: '' })],
  },
  {
    method: Method.CHAT_INPUT_SUBMIT,
    valid: [value('empty textual content', { chatId: 'chat-1', commandId: 'command-1', clientMessageId: 'client-1', messageId: 'message-1', content: '' })],
    invalid: [
      value('missing command id', { chatId: 'chat-1', clientMessageId: 'client-1', messageId: 'message-1', content: 'hello' }),
      value('bad attachment enum', {
        chatId: 'chat-1', commandId: 'command-1', clientMessageId: 'client-1', messageId: 'message-1', content: 'hello',
        attachments: [{ assetId: 'asset-1', kind: 'file', mimeType: 'text/plain' }],
      }),
    ],
  },
  {
    method: Method.CHAT_TIMELINE_GET,
    valid: [
      value('chat timeline', { chatId: 'chat-1', limit: 500, knownRevision: 0 }),
      value('root audit timeline', { rootChatId: 'root-1', view: 'audit', before: 10 }),
      value('task timeline', { taskId: 'task-1', before: 'cursor' }),
    ],
    invalid: [
      value('missing selector', {}),
      value('empty selector', { chatId: '' }),
      value('zero limit', { chatId: 'chat-1', limit: 0 }),
      value('limit above maximum', { chatId: 'chat-1', limit: 501 }),
      value('negative revision', { chatId: 'chat-1', knownRevision: -1 }),
    ],
  },
  {
    method: Method.CHAT_TIMELINE_GENERATION_GET,
    valid: [value('generation one', { rootChatId: 'root-1', generationIndex: 1 })],
    invalid: [value('zero generation', { rootChatId: 'root-1', generationIndex: 0 }), value('fractional generation', { rootChatId: 'root-1', generationIndex: 1.5 })],
  },
  {
    method: Method.CHAT_TIMELINE_NODE_GET,
    valid: [
      value('content page', { rootChatId: 'root-1', nodeId: 'node-1', sections: ['content'], offset: 0, limit: 32000 }),
      value('tool result page', {
        rootChatId: 'root-1', nodeId: 'node-1', sections: ['toolCalls'],
        toolCursor: { callIndex: 0, field: 'result', offset: 0 },
      }),
    ],
    invalid: [
      value('limit above maximum', { rootChatId: 'root-1', nodeId: 'node-1', limit: 32001 }),
      value('tool cursor plus offset', {
        rootChatId: 'root-1', nodeId: 'node-1', sections: ['toolCalls'], offset: 0,
        toolCursor: { callIndex: 0, field: 'arguments', offset: 0 },
      }),
      value('tool cursor with wrong section', {
        rootChatId: 'root-1', nodeId: 'node-1', sections: ['content'],
        toolCursor: { callIndex: 0, field: 'arguments', offset: 0 },
      }),
    ],
  },
  {
    method: Method.CHAT_RUN_RESUME,
    valid: [value('resume run', { chatId: 'chat-1', commandId: 'command-1' })],
    invalid: [value('missing command', { chatId: 'chat-1' }), value('empty chat', { chatId: '', commandId: 'command-1' })],
  },
  {
    method: Method.CHAT_RESUME_TREE,
    valid: [value('resume tree', { rootChatId: 'root-1', pauseId: 'pause-1', commandId: 'command-1' })],
    invalid: [value('missing pause', { rootChatId: 'root-1', commandId: 'command-1' }), value('empty command', { rootChatId: 'root-1', pauseId: 'pause-1', commandId: '' })],
  },
  {
    method: Method.CHAT_OPEN,
    valid: [
      value('direct chat subscription', { scope: 'chat', chatId: 'chat-1', knownEventSeq: 0 }),
      value('root tree subscription', { scope: 'root', rootChatId: 'root-1', view: 'tree', executionStepLimit: 500 }),
    ],
    invalid: [
      value('missing discriminator', { chatId: 'chat-1' }),
      value('chat scope missing chat', { scope: 'chat' }),
      value('root scope wrong view', { scope: 'root', rootChatId: 'root-1', view: 'audit' }),
      value('step limit above maximum', { scope: 'chat', chatId: 'chat-1', executionStepLimit: 501 }),
    ],
  },
  {
    method: Method.CHAT_CLOSE,
    valid: [value('close subscription', { subscriptionId: 'subscription-1' })],
    invalid: [value('missing subscription', {}), value('empty subscription', { subscriptionId: '' })],
  },
  {
    method: Method.CHAT_STOP_CHILD,
    valid: [value('recursive stop', { rootChatId: 'root-1', childChatId: 'child-1', commandId: 'command-1', recursive: true })],
    invalid: [value('missing child', { rootChatId: 'root-1', commandId: 'command-1' }), value('wrong recursive type', { rootChatId: 'root-1', childChatId: 'child-1', commandId: 'command-1', recursive: 'yes' })],
  },
  {
    method: Method.CHAT_ABORT,
    valid: [value('abort current run', { chatId: 'chat-1' }), value('idempotent targeted abort', { chatId: 'chat-1', runId: 'run-1', commandId: 'command-1' })],
    invalid: [value('empty chat', { chatId: '' }), value('empty run id', { chatId: 'chat-1', runId: '' }), value('empty command', { chatId: 'chat-1', commandId: '' })],
  },
]

const interactionAndConfigurationMatrices: MethodMatrix[] = [
  {
    method: Method.INTERACTION_LIST,
    valid: [value('default window', {}), value('bounded window', { presetId: 'preset-1', includeActivity: true, maxItems: 20 })],
    invalid: [value('zero max items', { maxItems: 0 }), value('above maximum', { maxItems: 21 }), value('empty preset', { presetId: '' })],
  },
  {
    method: Method.INTERACTION_APPROVAL_DECIDE,
    valid: [value('accept revision', { interactionId: 'interaction-1', action: 'accept', expectedRevision: 1, commandId: 'command-1' })],
    invalid: [value('unknown action', { interactionId: 'interaction-1', action: 'skip', expectedRevision: 1, commandId: 'command-1' }), value('zero revision', { interactionId: 'interaction-1', action: 'reject', expectedRevision: 0, commandId: 'command-1' })],
  },
  {
    method: Method.INTERACTION_QUESTION_ANSWER,
    valid: [value('single answer', {
      interactionId: 'interaction-1', expectedRevision: 1, commandId: 'command-1',
      answers: [{ questionId: 'question-1', selectedLabels: ['yes'] }],
    })],
    invalid: [
      value('empty answers', { interactionId: 'interaction-1', expectedRevision: 1, commandId: 'command-1', answers: [] }),
      value('missing question id', { interactionId: 'interaction-1', expectedRevision: 1, commandId: 'command-1', answers: [{ selectedLabels: [] }] }),
    ],
  },
  {
    method: Method.RUNTIME_SET,
    valid: [value('runtime selection', { chatId: 'chat-1', brain: 'brain-1', senseGroup: 'tools', mcpServers: ['mcp-1'] })],
    invalid: [value('empty brain', { chatId: 'chat-1', brain: '' }), value('empty mcp name', { chatId: 'chat-1', brain: 'brain-1', mcpServers: [''] })],
  },
  {
    method: Method.SESSION_RUNTIME_SET,
    valid: [value('primary plus role roster', {
      chatId: 'chat-1',
      primary: { brain: 'brain-1', senseGroup: 'tools' },
      roles: { reviewer: { brain: 'brain-2', senseGroup: 'read' } },
    })],
    invalid: [
      value('missing roles map', { chatId: 'chat-1', primary: { brain: 'brain-1' } }),
      value('empty role name', { chatId: 'chat-1', primary: { brain: 'brain-1' }, roles: { '': { brain: 'brain-2' } } }),
    ],
  },
]

const minimalConfig = {
  global: {
    thinking: false,
    supervision: 'auto',
    stream: true,
    command: {
      warn: { unit: 'percent', value: 0.8 },
      auto: { unit: 'tokens', value: 1000 },
    },
  },
  llm: { brain: { mock: { model: 'mock-model', provider: 'mock' } } },
}

const externalBoundaryMatrices: MethodMatrix[] = [
  {
    method: Method.CONFIG_SAVE,
    valid: [value('minimal complete config', minimalConfig)],
    invalid: [
      value('missing global', { llm: minimalConfig.llm }),
      value('invalid supervision enum', { ...minimalConfig, global: { ...minimalConfig.global, supervision: 'root' } }),
      value('percent threshold above one', {
        ...minimalConfig,
        global: { ...minimalConfig.global, command: { warn: { unit: 'percent', value: 1.01 } } },
      }),
      value('negative token threshold', {
        ...minimalConfig,
        global: { ...minimalConfig.global, command: { auto: { unit: 'tokens', value: -1 } } },
      }),
    ],
  },
  {
    method: Method.CONFIG_WORKSPACE_BROWSE_LIST,
    valid: [value('encrypted browse cursor', { sessionId: 'session-1', nonce: '0123456789abcdef', encPath: '', includeFiles: false })],
    invalid: [value('short nonce', { sessionId: 'session-1', nonce: 'abc', encPath: '' }), value('non-hex nonce', { sessionId: 'session-1', nonce: 'zzzzzzzzzzzzzzzz', encPath: '' }), value('unknown field', { sessionId: 'session-1', nonce: '0123456789abcdef', encPath: '', extra: true })],
  },
  {
    method: Method.SKILLS_LIST,
    valid: [value('maximum page size', { page: 1, pageSize: 200, search: 'memory' })],
    invalid: [value('zero page', { page: 0 }), value('fractional page', { page: 1.5 }), value('page size above maximum', { page: 1, pageSize: 201 })],
  },
  {
    method: Method.SKILLS_IMPORT_URL,
    valid: [value('credential import', { url: 'https://example.test/repo.git', branch: 'main', credentialId: 'credential-1' }), value('inline import', { url: 'https://example.test/repo.git', branch: 'main', username: 'git', password: 'secret' })],
    invalid: [value('missing branch', { url: 'https://example.test/repo.git' }), value('credential plus password', { url: 'https://example.test/repo.git', branch: 'main', credentialId: 'credential-1', password: 'secret' })],
  },
  {
    method: Method.PLUGINS_IMPORT_URL,
    valid: [value('named plugin import', { url: 'https://example.test/plugin.git', branch: 'main', pluginName: 'sample' })],
    invalid: [value('empty plugin name', { url: 'https://example.test/plugin.git', branch: 'main', pluginName: '' }), value('credential plus password', { url: 'https://example.test/plugin.git', branch: 'main', credentialId: 'credential-1', password: 'secret' })],
  },
  {
    method: Method.CREDENTIALS_SAVE,
    valid: [value('credential secret', { label: 'GitHub', username: 'git', password: 'secret' })],
    invalid: [value('empty label', { label: '', username: 'git', password: 'secret' }), value('missing password', { label: 'GitHub', username: 'git' })],
  },
  {
    method: Method.CREDENTIALS_DELETE,
    valid: [value('credential identity', { id: 'credential-1' })],
    invalid: [value('empty identity', { id: '' }), value('wrong identity type', { id: 1 })],
  },
]

function flatten(
  matrices: MethodMatrix[],
  kind: 'valid' | 'invalid',
): Array<{ method: Method; label: string; value: unknown }> {
  return matrices.flatMap((matrix) =>
    matrix[kind].map((entry) => ({ method: matrix.method, label: entry.label, value: entry.value })),
  )
}

describe('core request parameter matrix', () => {
  it('enumerates all 21 public chat methods', () => {
    expect(chatMatrices).toHaveLength(21)
    expect(new Set(chatMatrices.map((matrix) => matrix.method)).size).toBe(21)
  })

  it.each(flatten(chatMatrices, 'valid'))('$method accepts $label', ({ method, value }) => {
    expect(requestSchemas[method].safeParse(value).success).toBe(true)
  })

  it.each(flatten(chatMatrices, 'invalid'))('$method rejects $label', ({ method, value }) => {
    expect(requestSchemas[method].safeParse(value).success).toBe(false)
  })

  it.each(flatten(interactionAndConfigurationMatrices, 'valid'))(
    '$method accepts $label',
    ({ method, value }) => expect(requestSchemas[method].safeParse(value).success).toBe(true),
  )

  it.each(flatten(interactionAndConfigurationMatrices, 'invalid'))(
    '$method rejects $label',
    ({ method, value }) => expect(requestSchemas[method].safeParse(value).success).toBe(false),
  )

  it.each(flatten(externalBoundaryMatrices, 'valid'))(
    '$method accepts $label',
    ({ method, value }) => expect(requestSchemas[method].safeParse(value).success).toBe(true),
  )

  it.each(flatten(externalBoundaryMatrices, 'invalid'))(
    '$method rejects $label',
    ({ method, value }) => expect(requestSchemas[method].safeParse(value).success).toBe(false),
  )
})
