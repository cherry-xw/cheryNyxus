import { nextTick, watch, type Ref } from 'vue'
import type { MessageBranchTreeControllerProps } from './treeControllerTypes'
import type { useTreeGraphProjection } from './useTreeGraphProjection'

/** Root changes and view-mode transitions are the only automatic camera reset paths. */
export function useTreeModeReactions({
  props,
  graphProjection,
  camera,
  resetPiano,
  recoveryError,
  resetFoldReading,
  resetActionPopovers,
  resetCrtWindows,
  generationDialogIndex,
  generationDialogRootChatId,
  closeNodeDetail,
  gpuRenderError,
  restartGpuRenderer,
}: {
  props: MessageBranchTreeControllerProps
  graphProjection: Pick<
    ReturnType<typeof useTreeGraphProjection>,
    'resetGraphProjection' | 'paperEntries' | 'activePaperNodeId' | 'paperHasNewTail'
  >
  camera: {
    resetCameraForRoot: () => void
    resetCameraLayout: () => void
    resetLayout: () => boolean
    tryInitialFit: () => void
    hasNewTail: Ref<boolean>
  }
  resetPiano: () => void
  recoveryError: Ref<string>
  resetFoldReading: () => void
  resetActionPopovers: () => void
  resetCrtWindows: () => void
  generationDialogIndex: Ref<number | undefined>
  generationDialogRootChatId: Ref<string | undefined>
  closeNodeDetail: () => void
  gpuRenderError: Ref<string>
  restartGpuRenderer: () => void
}) {
  const { resetCameraForRoot, resetCameraLayout, resetLayout, tryInitialFit, hasNewTail } = camera
  const { resetGraphProjection, paperEntries, activePaperNodeId, paperHasNewTail } = graphProjection
  watch(
    () => props.rootChatId,
    (rootChatId, previousRootChatId) => {
      if (!rootChatId) return
      resetCameraForRoot()
      resetGraphProjection()
      resetCameraLayout()
      resetPiano()
      recoveryError.value = ''
      hasNewTail.value = false
      resetFoldReading()
      resetActionPopovers()
      activePaperNodeId.value = undefined
      paperHasNewTail.value = false
      generationDialogIndex.value = undefined
      generationDialogRootChatId.value = undefined
      if (previousRootChatId && previousRootChatId !== rootChatId) {
        resetCrtWindows()
      }
      closeNodeDetail()
      void nextTick(tryInitialFit)
    },
    { immediate: true },
  )
  watch(
    () => props.paperMode,
    (enabled) => {
      closeNodeDetail()
      if (enabled && !activePaperNodeId.value)
        activePaperNodeId.value = paperEntries.value.at(-1)?.id
      // 卡牌模式与流程图/阅读器一样以右侧抽屉覆盖节点树（不再压缩树视口），
      // 开关不重排画布相机，保留用户当前平移与缩放。
    },
  )
  // 抽屉开关只收拢节点详情，不重排画布相机。
  watch(
    () => props.sidePanelOpen,
    () => closeNodeDetail(),
  )
  watch(
    () => props.foldMode,
    () => {
      closeNodeDetail()
      // 折叠档位改变会整体重排投影图（节点增删），旧相机位置/缩放已不再对应新图。
      // 与切根一致：清空增量布局缓存并重新 fit 到新投影，否则开始/末尾节点定位不到视口内。
      resetCameraLayout()
      void nextTick(resetLayout)
    },
  )
  watch(
    () => props.layoutMode,
    () => {
      closeNodeDetail()
      resetCameraLayout()
      void nextTick(resetLayout)
    },
  )
  watch(
    () => props.presentationMode,
    () => {
      closeNodeDetail()
      void nextTick(resetLayout)
      if (gpuRenderError.value) {
        restartGpuRenderer()
      }
    },
  )
}
