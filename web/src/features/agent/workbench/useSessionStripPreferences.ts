import { onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import {
  EMPTY_SESSION_STRIP_PREFERENCE,
  type SessionStripItem,
  type SessionStripPreference,
  type SessionStripSlot,
} from './useSessionStripTasks'

const STORAGE_PREFIX = 'chery:workbench-session-strip:'
const CHANNEL_NAME = 'chery-workbench-session-strip'
const TASK_STATUSES = new Set([
  'idle',
  'needs_user',
  'running',
  'paused',
  'stopped',
  'failed',
  'completed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseItem(value: unknown): SessionStripItem | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.taskKey !== 'string' ||
    typeof value.rootChatId !== 'string' ||
    typeof value.originalChatId !== 'string' ||
    typeof value.openChatId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.status !== 'string' ||
    !TASK_STATUSES.has(value.status) ||
    typeof value.unreadResult !== 'boolean' ||
    typeof value.attentionKey !== 'string' ||
    typeof value.pendingCount !== 'number' ||
    typeof value.updatedAt !== 'number'
  ) {
    return undefined
  }
  const latestResult = isRecord(value.latestResult)
    && typeof value.latestResult.resultId === 'string'
    && typeof value.latestResult.status === 'string'
    && ['paused', 'stopped', 'failed', 'completed'].includes(value.latestResult.status)
    && typeof value.latestResult.completedAt === 'number'
    ? {
        resultId: value.latestResult.resultId,
        status: value.latestResult.status as NonNullable<SessionStripItem['latestResult']>['status'],
        completedAt: value.latestResult.completedAt,
        ...(typeof value.latestResult.content === 'string'
          ? { content: value.latestResult.content }
          : {}),
      }
    : undefined
  return {
    taskKey: value.taskKey,
    rootChatId: value.rootChatId,
    originalChatId: value.originalChatId,
    openChatId: value.openChatId,
    relatedChatIds: Array.isArray(value.relatedChatIds)
      ? value.relatedChatIds.filter((chatId): chatId is string => typeof chatId === 'string')
      : [],
    title: value.title,
    ...(typeof value.lastUserPrompt === 'string' ? { lastUserPrompt: value.lastUserPrompt } : {}),
    status: value.status as SessionStripItem['status'],
    ...(typeof value.currentStep === 'string' ? { currentStep: value.currentStep } : {}),
    ...(latestResult ? { latestResult } : {}),
    unreadResult: value.unreadResult,
    attentionKey: value.attentionKey,
    pendingCount: value.pendingCount,
    updatedAt: value.updatedAt,
  }
}

export function parseSessionStripPreference(value: unknown): SessionStripPreference {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.slots)) {
    return { ...EMPTY_SESSION_STRIP_PREFERENCE, slots: [], dismissedAttentionKeys: {} }
  }
  const slots = value.slots.slice(0, 5).flatMap((candidate): SessionStripSlot[] => {
    if (!isRecord(candidate) || typeof candidate.taskKey !== 'string') return []
    const snapshot = parseItem(candidate.snapshot)
    if (!snapshot || snapshot.taskKey !== candidate.taskKey) return []
    return [{ taskKey: candidate.taskKey, snapshot }]
  })
  const dismissedAttentionKeys = isRecord(value.dismissedAttentionKeys)
    ? Object.fromEntries(
        Object.entries(value.dismissedAttentionKeys).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {}
  return { version: 1, slots, dismissedAttentionKeys }
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(scope)}`
}

function readPreference(scope: string): SessionStripPreference {
  try {
    if (typeof localStorage === 'undefined') return parseSessionStripPreference(undefined)
    return parseSessionStripPreference(JSON.parse(localStorage.getItem(storageKey(scope)) ?? 'null'))
  } catch {
    return parseSessionStripPreference(undefined)
  }
}

function samePreference(left: SessionStripPreference, right: SessionStripPreference): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function useSessionStripPreferences(scope: Ref<string>) {
  const preference = shallowRef(readPreference(scope.value))
  const channel =
    typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(CHANNEL_NAME)
      : undefined

  function receive(nextScope: unknown, value: unknown): void {
    if (nextScope !== scope.value) return
    const next = parseSessionStripPreference(value)
    if (!samePreference(preference.value, next)) preference.value = next
  }

  function setPreference(next: SessionStripPreference): void {
    if (samePreference(preference.value, next)) return
    preference.value = next
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey(scope.value), JSON.stringify(next))
      }
    } catch {
      // 持久化不可用时保留当前 renderer 内的状态。
    }
    channel?.postMessage({ scope: scope.value, value: next })
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== storageKey(scope.value)) return
    try {
      receive(scope.value, JSON.parse(event.newValue ?? 'null'))
    } catch {
      receive(scope.value, undefined)
    }
  }

  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data)) return
      receive(event.data.scope, event.data.value)
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

  watch(scope, (nextScope) => {
    preference.value = readPreference(nextScope)
  })

  onScopeDispose(() => {
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    channel?.close()
  })

  return { preference, setPreference }
}
