import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue'
import type {
  MessageBranchTreeControllerProps,
  MessageBranchTreeControllerEmits,
  ControllerEmit,
} from './treeControllerTypes'
import { useThemeTokens } from '@/composables/useThemeTokens'
import { renderQualityTier } from '@/composables/renderQuality'
import type { useNyxusHost } from '../application/host'
import type { useTreeGraphProjection } from './useTreeGraphProjection'
import type { useTreeCanvas } from '../composables/useTreeCanvas'
import {
  projectExecutionPresentation,
  signalAccentForTheme,
  signalVisualKindFor,
  foldContainsErrorMessage,
} from '../graph/executionPresentation'
import { skinForNode, accentForTheme } from '../graph/nodeSkins'
import { terminationDisplay } from '../graph/termination'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import {
  ExecutionGraphPixiRenderer,
  type PixiExecutionScene,
} from '../renderer/ExecutionGraphPixiRenderer'
import { executionSceneSignature } from '../renderer/executionSceneSignature'
import type { ExecutionCamera } from '../renderer/executionViewport'
import type { ShallowRef } from 'vue'

/** 0xRRGGBB → '#rrggbb'（把 palette 里的数值色转为场景边可携带的字符串色）。 */
function hexColor(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

/** GPU scene projection and renderer lifetime; mounting stays in the parent's viewport lifecycle. */
export function useTreeGpuScene({
  props,
  emit,
  layout,
  canvas,
  visibleExecutionItems,
  visibleExecutionKey,
  viewportSelectionCamera,
  executionCamera,
  themeStore,
  canvasPalette,
  coreFlowProjection,
  runningTailIds,
  awaitingInteractionNodeIds,
  hoveredDetailNodeId,
  pinnedDetailNodeId,
  activePaperNodeId,
  containsBranchAnchor,
  isPaused,
  isError,
  compactNodeTitle,
}: {
  props: MessageBranchTreeControllerProps
  emit: ControllerEmit<MessageBranchTreeControllerEmits>
  layout: ComputedRef<ReturnType<typeof projectExecutionPresentation>>
  canvas: ReturnType<typeof useTreeCanvas>
  visibleExecutionItems: ComputedRef<
    ReturnType<typeof import('../renderer/executionViewport').selectVisibleExecutionItems>
  >
  visibleExecutionKey: ComputedRef<string>
  viewportSelectionCamera: ShallowRef<ExecutionCamera>
  executionCamera: ComputedRef<ExecutionCamera>
  themeStore: ReturnType<typeof useNyxusHost>['theme']
  canvasPalette: ReturnType<typeof useThemeTokens>['canvasPalette']
  coreFlowProjection: ReturnType<typeof useTreeGraphProjection>['coreFlowProjection']
  runningTailIds: ComputedRef<Set<string>>
  awaitingInteractionNodeIds: ComputedRef<Set<string>>
  hoveredDetailNodeId: Ref<string | undefined>
  pinnedDetailNodeId: Ref<string | undefined>
  activePaperNodeId: Ref<string | undefined>
  containsBranchAnchor: (node: PositionedExecutionNode) => boolean
  isPaused: (node: PositionedExecutionNode) => boolean
  isError: (node: PositionedExecutionNode) => boolean
  compactNodeTitle: (node: PositionedExecutionNode) => string
}) {
  const pixiMountRef = ref<HTMLElement | null>(null)
  const gpuRenderError = ref('')
  let gpuRenderer: ExecutionGraphPixiRenderer | undefined
  let gpuMountGeneration = 0
  let lastGpuSceneSignature = ''
  const pixiScene = computed<PixiExecutionScene>(() => ({
    presentation: layout.value.presentation ?? 'vertical-classic',
    nodes: visibleExecutionItems.value.nodes.map((node) => {
      const skin = skinForNode(node)
      const visualKind = signalVisualKindFor(node, node.presentationPriority ?? 'process')
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        accent:
          layout.value.presentation === 'horizontal-signal'
            ? signalAccentForTheme(themeStore.theme, visualKind)
            : accentForTheme(themeStore.theme, skin.key),
        glyph: skin.glyph,
        title: compactNodeTitle(node),
        effect: node.effect,
        visualKind,
        ...(node.sourceFact?.termination
          ? { termination: terminationDisplay(node.sourceFact.termination).label }
          : {}),
        ...(node.kind === 'fold' || node.kind === 'round') && node.fold
          ? { foldCount: node.fold.members.length }
          : {},
        ...(node.kind === 'pack' && node.pack ? { foldCount: node.pack.nodeCount } : {}),
        running: runningTailIds.value.has(node.id),
        awaitingInteraction: awaitingInteractionNodeIds.value.has(node.id),
        detailActive:
          hoveredDetailNodeId.value === node.id ||
          pinnedDetailNodeId.value === node.id ||
          Boolean(props.paperMode && activePaperNodeId.value === node.id),
        branchAnchorKind: containsBranchAnchor(node) ? props.branchAnchorKind : undefined,
        paused: isPaused(node),
        error: isError(node),
        containsErrorMessage: foldContainsErrorMessage(node),
        revoked: node.status === 'revoked',
        deemphasized: !coreFlowProjection.value.coreNodeIds.has(node.id),
        detailBranch: coreFlowProjection.value.detailNodeIds.has(node.id),
      }
    }),
    edges: visibleExecutionItems.value.edges.map((edge) => {
      const detailBranch =
        coreFlowProjection.value.detailNodeIds.has(edge.from.id) ||
        coreFlowProjection.value.detailNodeIds.has(edge.to.id)
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        fromColor: gpuNodeEndpointColor(edge.from),
        toColor: gpuNodeEndpointColor(edge.to),
        active: runningTailIds.value.has(edge.from.id) || runningTailIds.value.has(edge.to.id),
        phaseSeconds: (edge.to.createdAt % 1300) / 1000,
        deemphasized:
          !coreFlowProjection.value.coreNodeIds.has(edge.from.id) ||
          !coreFlowProjection.value.coreNodeIds.has(edge.to.id),
        detailBranch,
        ...(edge.routeX === undefined ? {} : { routeX: edge.routeX }),
        ...(edge.routeY === undefined ? {} : { routeY: edge.routeY }),
        horizontal: layout.value.presentation === 'horizontal-signal',
        fromHalfWidth: edge.from.visualBounds
          ? (edge.from.visualBounds.right - edge.from.visualBounds.left) / 2
          : undefined,
        toHalfWidth: edge.to.visualBounds
          ? (edge.to.visualBounds.right - edge.to.visualBounds.left) / 2
          : undefined,
      }
    }),
  }))
  function gpuNodeAccent(node: (typeof layout.value.nodes)[number]): string {
    const signal = layout.value.presentation === 'horizontal-signal'
    return signal
      ? signalAccentForTheme(
          themeStore.theme,
          signalVisualKindFor(node, node.presentationPriority ?? 'process'),
        )
      : accentForTheme(themeStore.theme, skinForNode(node).key)
  }
  /**
   * 连线渐变端点色：与节点实际显示色保持一致——Signal 下错误/撤销/暂停覆盖为状态色，
   * 其余用节点语义色（Classic 恒用语义色）。
   */
  function gpuNodeEndpointColor(node: PositionedExecutionNode): string {
    if (layout.value.presentation === 'horizontal-signal') {
      const p = canvasPalette.value
      if (isError(node)) return hexColor(p.stateError)
      if (node.status === 'revoked') return hexColor(p.stateRevoked)
      if (isPaused(node)) return hexColor(p.statePaused)
    }
    return gpuNodeAccent(node)
  }
  function gpuNodeHitStyle(node: (typeof layout.value.nodes)[number]): Record<string, string> {
    const position = canvas.worldToScreen(node)
    const signal = layout.value.presentation === 'horizontal-signal'
    const visualWidth = node.visualBounds
      ? node.visualBounds.right - node.visualBounds.left + 12
      : signal
        ? 104
        : 46
    const visualHeight = node.visualBounds
      ? node.visualBounds.bottom - node.visualBounds.top + 12
      : signal
        ? 56
        : 46
    const width = Math.max(30, visualWidth * canvas.scale.value)
    const height = Math.max(30, visualHeight * canvas.scale.value)
    return {
      width: `${width}px`,
      height: `${height}px`,
      borderRadius: signal ? '3px' : '50%',
      '--tree-node-accent': gpuNodeAccent(node),
      transform: `translate3d(${position.x - width / 2}px, ${position.y - height / 2}px, 0)`,
    }
  }
  function syncGpuScene(scene = pixiScene.value): void {
    if (props.suspended) return
    const signature = executionSceneSignature(scene, visibleExecutionKey.value)
    const appliedToPixi = signature !== lastGpuSceneSignature
    if (!appliedToPixi) return
    lastGpuSceneSignature = signature
    gpuRenderer?.setScene(scene)
  }
  watch(
    executionCamera,
    (camera) => {
      gpuRenderer?.setCamera(camera)
      if (!canvas.dragging.value) viewportSelectionCamera.value = camera
    },
    { deep: true, flush: 'sync' },
  )
  watch(pixiScene, (scene) => syncGpuScene(scene))
  watch(renderQualityTier, (tier) => gpuRenderer?.setQualityTier(tier))
  // 主题切换：更新画布调色板并重画静态层（accent 随 pixiScene 重算）。
  watch(canvasPalette, (palette) => gpuRenderer?.setPalette(palette))
  watch(
    () => props.paperMode,
    (paperMode) => gpuRenderer?.setMotionFrameRate(paperMode ? 24 : 30),
    { immediate: true },
  )
  watch(
    () => props.suspended,
    (suspended) => {
      gpuRenderer?.setSuspended(!!suspended)
      if (!suspended) syncGpuScene()
    },
    { immediate: true },
  )
  async function mountGpuRenderer(): Promise<void> {
    const host = pixiMountRef.value
    if (!host) return
    const generation = ++gpuMountGeneration
    const renderer = new ExecutionGraphPixiRenderer()
    gpuRenderer = renderer
    renderer.setScene(pixiScene.value)
    renderer.setPalette(canvasPalette.value)
    renderer.setQualityTier(renderQualityTier.value)
    renderer.setMotionFrameRate(props.paperMode ? 24 : 30)
    renderer.setSuspended(!!props.suspended)
    try {
      await renderer.mount(host)
    } catch (error) {
      if (generation === gpuMountGeneration) {
        gpuRenderError.value = error instanceof Error ? error.message : 'GPU 渲染器初始化失败'
        if (props.presentationMode === 'horizontal-signal') {
          emit('presentation-fallback', gpuRenderError.value)
        }
      }
      return
    }
    if (generation !== gpuMountGeneration) {
      renderer.destroy()
      return
    }
    renderer.setCamera(executionCamera.value)
    gpuRenderError.value = ''
    lastGpuSceneSignature = ''
    syncGpuScene()
  }
  function restartGpuRenderer(): void {
    gpuRenderer?.destroy()
    gpuRenderer = undefined
    void nextTick(mountGpuRenderer)
  }
  function resizeGpuRenderer(width: number, height: number): void {
    gpuRenderer?.resize(width, height)
  }
  function disposeGpuRenderer(): void {
    gpuMountGeneration += 1
    gpuRenderer?.destroy()
    gpuRenderer = undefined
  }
  return {
    pixiMountRef,
    gpuRenderError,
    gpuNodeAccent,
    gpuNodeHitStyle,
    mountGpuRenderer,
    restartGpuRenderer,
    resizeGpuRenderer,
    disposeGpuRenderer,
    renderer: () => gpuRenderer,
  }
}
