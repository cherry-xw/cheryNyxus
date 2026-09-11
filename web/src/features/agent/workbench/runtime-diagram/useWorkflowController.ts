import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import type {
  WorkflowHistoryResponse,
  WorkflowHistoryRequest,
  WorkflowOpenResponse,
  WorkflowUpdated,
} from '@chery/protocol'
import { workflowApi } from '@/application/backend/public'
import { acceptWorkflow, replayFrames, replaySnapshot } from './model'
import { readWorkflowHistoryPages } from './workflowHistoryLoader'
import {
  applyWorkflowUpdate,
  buildWorkflowReplayState,
  installWorkflowSnapshot,
  workflowReplayLength,
  type WorkflowClientState,
} from './workflowState'
import type { WorkflowMotionSource } from './motionPolicy'

export interface WorkflowChangeSignal {
  serial: number
  source: WorkflowMotionSource
  rootChatId: string
}

export type WorkflowDetailHistoryTarget = Pick<
  WorkflowHistoryRequest,
  'sourceChatId' | 'runId' | 'contextStageId'
>

export function useWorkflowController(chatId: Ref<string>, suspended: Ref<boolean>) {
  const observerId = crypto.randomUUID()
  const live = shallowRef<WorkflowUpdated>()
  const workflowState = shallowRef<WorkflowClientState>()
  const history = shallowRef<WorkflowHistoryResponse>()
  const detailHistory = shallowRef<WorkflowHistoryResponse>()
  const loading = ref(false)
  const historyLoading = ref(false)
  const detailHistoryLoading = ref(false)
  const error = ref('')
  const historyError = ref('')
  const detailHistoryError = ref('')
  const synced = ref(workflowApi.connected())
  const replay = ref(false)
  const playing = ref(false)
  const speed = ref(1)
  const cursor = ref(0)
  const workflowChange = shallowRef<WorkflowChangeSignal>({
    serial: 0,
    source: 'reset',
    rootChatId: chatId.value,
  })
  let workflowChangeSerial = 0
  let generation = 0
  let historyGeneration = 0
  let detailHistoryGeneration = 0
  let lease: WorkflowOpenResponse | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const early = new Map<string, WorkflowUpdated[]>()
  let opening = Promise.resolve()
  const hidden = ref(typeof document !== 'undefined' && document.hidden)
  const onVisibility = () => {
    hidden.value = document.hidden
    if (hidden.value) pause()
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
  const frames = computed(() => replayFrames(history.value?.facts ?? []))
  const replayLength = computed(() => workflowReplayLength(history.value))
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
  const projectedWorkflowState = computed(() => {
    if (!replay.value || !history.value) return workflowState.value
    return buildWorkflowReplayState(history.value, cursor.value)
  })
  function publishWorkflowChange(source: WorkflowMotionSource, rootChatId = chatId.value): void {
    workflowChange.value = { serial: ++workflowChangeSerial, source, rootChatId }
  }
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
    cursor.value = Math.max(0, Math.min(replayLength.value - 1, index))
  }
  function tick() {
    clearTimer()
    if (!playing.value || suspended.value || hidden.value || !replay.value || historyLoading.value)
      return
    timer = setTimeout(() => {
      if (cursor.value >= replayLength.value - 1) {
        pause()
        return
      }
      cursor.value++
      tick()
    }, 700 / speed.value)
  }
  function play() {
    if (!replayLength.value || historyLoading.value || suspended.value || hidden.value) return
    if (playing.value) {
      pause()
      return
    }
    if (cursor.value >= replayLength.value - 1) cursor.value = 0
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
      workflowState.value = response.steps ? installWorkflowSnapshot(response.steps) : undefined
      let reload = false
      for (const buffered of early.get(response.subscriptionId) ?? []) {
        if (acceptWorkflow(live.value, buffered, response, target)) live.value = buffered
        if (buffered.baseRevision !== undefined || buffered.invalidated) {
          const decision = applyWorkflowUpdate(workflowState.value, buffered, response)
          if (decision.kind === 'applied') workflowState.value = decision.state
          else if (decision.kind === 'reload') reload = true
        }
      }
      early.clear()
      publishWorkflowChange('hydrate', target)
      synced.value = true
      if (reload) void open()
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
    if (!lease) {
      const buffered = early.get(event.subscriptionId) ?? []
      if (buffered.length < 200) buffered.push(event)
      early.set(event.subscriptionId, buffered)
      return
    }
    if (acceptWorkflow(live.value, event, lease, chatId.value)) live.value = event
    if (event.subscriptionId !== lease.subscriptionId || event.streamId !== lease.streamId) return
    if (event.baseRevision !== undefined || event.invalidated) {
      const decision = applyWorkflowUpdate(workflowState.value, event, lease)
      if (decision.kind === 'applied') {
        workflowState.value = decision.state
        publishWorkflowChange('live', decision.state.rootChatId)
      } else if (decision.kind === 'reload') void open()
    }
  })
  const offStatus = workflowApi.onStatus((connected) => {
    synced.value = false
    if (connected) void open()
    else {
      ++generation
      lease = undefined
      loading.value = false
      clearDetailHistory()
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
      const loaded = await readWorkflowHistoryPages(
        { chatId: target, contextStageId: stage },
        workflowApi.history,
        () => token !== historyGeneration,
      )
      if (loaded && token === historyGeneration) history.value = loaded
    } catch (cause) {
      if (token === historyGeneration)
        historyError.value = cause instanceof Error ? cause.message : '历史加载失败，请重试'
    } finally {
      if (token === historyGeneration) historyLoading.value = false
    }
  }
  async function loadDetailHistory(filters: WorkflowDetailHistoryTarget = {}) {
    const token = ++detailHistoryGeneration
    detailHistoryLoading.value = true
    detailHistoryError.value = ''
    detailHistory.value = undefined
    const target = chatId.value
    try {
      const loaded = await readWorkflowHistoryPages(
        { chatId: target, ...filters },
        workflowApi.history,
        () => token !== detailHistoryGeneration || target !== chatId.value,
      )
      if (loaded && token === detailHistoryGeneration) detailHistory.value = loaded
    } catch (cause) {
      if (token === detailHistoryGeneration)
        detailHistoryError.value =
          cause instanceof Error ? cause.message : '步骤记录加载失败，请重试'
    } finally {
      if (token === detailHistoryGeneration) detailHistoryLoading.value = false
    }
  }
  function clearDetailHistory() {
    ++detailHistoryGeneration
    detailHistoryLoading.value = false
    detailHistoryError.value = ''
    detailHistory.value = undefined
  }
  function returnLive() {
    ++historyGeneration
    historyLoading.value = false
    replay.value = false
    pause()
    if (workflowApi.connected()) void open()
  }
  watch(
    chatId,
    () => {
      ++historyGeneration
      clearDetailHistory()
      pause()
      history.value = undefined
      live.value = undefined
      workflowState.value = undefined
      replay.value = false
      publishWorkflowChange('reset')
      void open()
    },
    { immediate: true },
  )
  watch(speed, tick)
  watch(suspended, (value) => {
    if (value) {
      pause()
      clearDetailHistory()
    }
  })
  onBeforeUnmount(() => {
    ++generation
    ++historyGeneration
    ++detailHistoryGeneration
    pause()
    offUpdate()
    offStatus()
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibility)
    void closeLease()
  })
  return {
    snapshot,
    workflowState: projectedWorkflowState,
    live,
    loading,
    historyLoading,
    detailHistoryLoading,
    error,
    historyError,
    detailHistoryError,
    synced,
    replay,
    playing,
    speed,
    cursor,
    frames,
    replayLength,
    history,
    detailHistory,
    hidden,
    workflowChange,
    play,
    pause,
    seek,
    open,
    loadHistory,
    loadDetailHistory,
    clearDetailHistory,
    returnLive,
  }
}
