import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type {
  WorkflowHistoryResponse,
  WorkflowOpenResponse,
  WorkflowUpdated,
} from '@chery/protocol'
import { workflowApi } from '@/application/backend/public'
import { acceptWorkflow, replayFrames, replaySnapshot } from './model'

export function useWorkflowController(chatId: Ref<string>, suspended: Ref<boolean>) {
  const observerId = crypto.randomUUID()
  const live = shallowRef<WorkflowUpdated>()
  const history = shallowRef<WorkflowHistoryResponse>()
  const loading = ref(false)
  const historyLoading = ref(false)
  const error = ref('')
  const historyError = ref('')
  const synced = ref(workflowApi.connected())
  const replay = ref(false)
  const playing = ref(false)
  const speed = ref(1)
  const cursor = ref(0)
  let generation = 0
  let historyGeneration = 0
  let lease: WorkflowOpenResponse | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let early = new Map<string, WorkflowUpdated>()
  let opening = Promise.resolve()
  const hidden = ref(typeof document !== 'undefined' && document.hidden)
  const onVisibility = () => {
    hidden.value = document.hidden
    if (hidden.value) pause()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  const frames = computed(() => replayFrames(history.value?.facts ?? []))
  const snapshot = computed(() => {
    if (!replay.value || !history.value) return live.value?.snapshot
    const page = history.value
    return replaySnapshot(
      {
        chatId: page.chatId,
        rootChatId: page.chatId,
        revision: 0,
        contextStageId: page.contextStageId,
        status: 'unknown',
        visitedNodeIds: [],
        dispatches: [],
        resources: {
          ...page.resources,
          loadedSkillCount: 0,
          loadedSkillsComplete: page.historyComplete,
        },
        phaseKnown: false,
        historyComplete: page.historyComplete,
      },
      frames.value,
      cursor.value,
    )
  })
  function clearTimer() {
    if (timer) clearTimeout(timer)
    timer = undefined
  }
  function pause() {
    playing.value = false
    clearTimer()
  }
  function seek(index: number) {
    pause()
    cursor.value = Math.max(0, Math.min(frames.value.length - 1, index))
  }
  function tick() {
    clearTimer()
    if (!playing.value || suspended.value || hidden.value || !replay.value || historyLoading.value)
      return
    timer = setTimeout(() => {
      if (cursor.value >= frames.value.length - 1) {
        pause()
        return
      }
      cursor.value++
      tick()
    }, 700 / speed.value)
  }
  function play() {
    if (!frames.value.length || historyLoading.value || suspended.value || hidden.value) return
    if (playing.value) {
      pause()
      return
    }
    if (cursor.value >= frames.value.length - 1) cursor.value = 0
    playing.value = true
    tick()
  }
  async function closeLease() {
    const previous = lease
    lease = undefined
    if (previous)
      try {
        await workflowApi.close(previous.subscriptionId)
      } catch {
        /* Disconnect reclaims server leases. */
      }
  }
  function open() {
    const token = ++generation
    const target = chatId.value
    opening = opening.then(() => openTarget(token, target))
    return opening
  }
  async function openTarget(token: number, target: string) {
    if (token !== generation) return
    early.clear()
    loading.value = true
    error.value = ''
    await closeLease()
    if (token !== generation || !target) return
    try {
      const response = await workflowApi.open({ chatId: target, observerId })
      if (token !== generation) {
        await workflowApi.close(response.subscriptionId)
        return
      }
      lease = response
      live.value = response
      const buffered = early.get(response.subscriptionId)
      if (buffered && acceptWorkflow(live.value, buffered, response, target)) live.value = buffered
      early.clear()
      synced.value = true
    } catch (cause) {
      if (token === generation) {
        error.value = cause instanceof Error ? cause.message : '流程加载失败，请重试'
        synced.value = false
      }
    } finally {
      if (token === generation) loading.value = false
    }
  }
  const offUpdate = workflowApi.onUpdate((event) => {
    if (event.snapshot.chatId !== chatId.value) return
    if (!lease) {
      const previous = early.get(event.subscriptionId)
      if (
        !previous ||
        event.streamId !== previous.streamId ||
        event.snapshot.revision > previous.snapshot.revision
      )
        early.set(event.subscriptionId, event)
      return
    }
    if (acceptWorkflow(live.value, event, lease, chatId.value)) live.value = event
  })
  const offStatus = workflowApi.onStatus((connected) => {
    synced.value = false
    if (connected) void open()
    else {
      ++generation
      lease = undefined
      loading.value = false
      pause()
    }
  })
  async function loadHistory(stage?: string) {
    const token = ++historyGeneration
    pause()
    replay.value = true
    historyLoading.value = true
    historyError.value = ''
    cursor.value = 0
    history.value = undefined
    const target = chatId.value
    try {
      let page = await workflowApi.history({ chatId: target, contextStageId: stage })
      const facts = [...page.facts]
      const seen = new Set<string>()
      while (!page.complete) {
        if (!page.nextCursor || seen.has(page.nextCursor))
          throw new Error('历史分页未完成，请重新加载回放')
        seen.add(page.nextCursor)
        if (token !== historyGeneration) return
        page = await workflowApi.history({
          chatId: target,
          contextStageId: page.contextStageId,
          cursor: page.nextCursor,
        })
        facts.push(...page.facts)
      }
      if (token === historyGeneration) history.value = { ...page, facts }
    } catch (cause) {
      if (token === historyGeneration)
        historyError.value = cause instanceof Error ? cause.message : '历史加载失败，请重试'
    } finally {
      if (token === historyGeneration) historyLoading.value = false
    }
  }
  function returnLive() {
    ++historyGeneration
    historyLoading.value = false
    replay.value = false
    pause()
    if (!synced.value && workflowApi.connected()) void open()
  }
  watch(
    chatId,
    () => {
      ++historyGeneration
      pause()
      history.value = undefined
      live.value = undefined
      replay.value = false
      void open()
    },
    { immediate: true },
  )
  watch(speed, tick)
  watch(suspended, (value) => {
    if (value) pause()
  })
  onBeforeUnmount(() => {
    ++generation
    ++historyGeneration
    pause()
    offUpdate()
    offStatus()
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibility)
    void closeLease()
  })
  return {
    snapshot,
    live,
    loading,
    historyLoading,
    error,
    historyError,
    synced,
    replay,
    playing,
    speed,
    cursor,
    frames,
    history,
    play,
    pause,
    seek,
    open,
    loadHistory,
    returnLive,
  }
}
