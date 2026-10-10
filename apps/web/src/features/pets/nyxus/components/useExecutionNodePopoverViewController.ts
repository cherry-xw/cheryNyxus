import { ref } from 'vue'
import { gsap } from 'gsap'
import {
  useExecutionNodePopoverController,
  type ExecutionNodePopoverControllerProps,
  type ExecutionNodePopoverControllerEmits,
} from './useExecutionNodePopoverController'
import { useGsap } from '@/composables/useGsap'
import { useMotionPreference } from '@/composables/useMotionPreference'
import { MOTION } from '@/utils/gsapCore'
import QuestionCard from '@/features/agent/cards/QuestionCard.vue'
import ApprovalCard from '@/features/agent/cards/ApprovalCard.vue'
import RiskBadge from '@/components/RiskBadge.vue'
import QuestionAnswerDetail from './QuestionAnswerDetail.vue'
import TodoRenderer from '@/features/agent/renderers/io/TodoRenderer.vue'
import ToolDescriptionDisclosure from '@/features/agent/renderers/ToolDescriptionDisclosure.vue'

export function useExecutionNodePopoverViewController(props: Readonly<ExecutionNodePopoverControllerProps>, emit: Parameters<typeof useExecutionNodePopoverController>[1]) {
  /**
   * 工具说明浮层主题（CRT 终端配色）：面板 Teleport 到 body，脱离 popover DOM，
   * 需通过 theme prop 传入与 CRT 调色板一致的 CSS 变量（浅/深主题 --nx-* 已随主题翻转）。
   */
  const crtDisclosureTheme = {
    '--ink': 'var(--nx-text)',
    '--panel': 'color-mix(in srgb, var(--nx-bg) 88%, var(--nx-text))',
    '--surface': 'color-mix(in srgb, var(--nx-bg) 88%, var(--nx-text))',
    '--border': 'var(--nx-border-soft)',
    '--accent': 'var(--nx-cyan)',
    '--accent-soft': 'color-mix(in srgb, var(--nx-cyan) 12%, transparent)',
  } satisfies Record<string, string>

  const controller = useExecutionNodePopoverController(props, emit)

  const {
    ElTooltip,
    RESULT_PREVIEW_LIMIT,
    RISK_LEVEL_LABEL,
    ToolFieldTree,
    activeQuestionCall,
    actualDescription,
    approval,
    batch,
    batchInfo,
    canBranch,
    copiedFieldKey,
    copyField,
    foldPosition,
    isQuestionCall,
    isQuestionTool,
    isReadFileTool,
    isSearchTool,
    isSkillTool,
    isSpawnTool,
    isTodoTool,
    isUserNode,
    nodeContent,
    nodeContentSegments,
    nodeDescription,
    nodeStatus,
    nodeTermination,
    nodeThinking,
    nodeTime,
    nodeTitle,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
    primaryInstruction,
    questionAnswer,
    questionArgs,
    readFileContent,
    readFileLineCount,
    readFilePath,
    readFilePreview,
    readFileRange,
    renderedActualDescription,
    renderedNodeContent,
    renderedNodeDescription,
    renderedNodeThinking,
    renderedPrimaryInstruction,
    renderedResult,
    renderedSkillContent,
    renderedSpawnPrompt,
    resultFields,
    resultTruncated,
    riskLevelOf,
    searchConfiguration,
    searchMode,
    searchPath,
    searchQuery,
    searchResult,
    secondaryFields,
    selectedCall,
    selectedStatus,
    skillResult,
    skinForNode,
    spawnPrompt,
    spawnRole,
    spawnWake,
    stepFold,
    terminationDisplay,
    thinkingOpen,
    todoSenseCall,
    toolBatchUsesTabs,
    toolGlyph,
    toolIcon,
    toolLabel,
  } = controller

  /**
   * 入场时间线：
   * 标题栏 → 页签 → 正文 stagger，总时长 ≤320ms，只动 transform/autoAlpha。
   * 仅组件挂载时执行一次——hover 链上切换节点复用同一实例，不重放。
   */
  const popoverRoot = ref<HTMLElement | null>(null)

  const { effectiveMode } = useMotionPreference()

  useGsap(popoverRoot, (context) => {
    context.add(() => {
      if (effectiveMode.value === 'reduced') return
      const head = popoverRoot.value?.querySelector('.popover-chrome')
      const tabs = popoverRoot.value?.querySelector('.tool-tabs')
      const body = popoverRoot.value?.querySelectorAll('.popover-body > *')
      const timeline = gsap.timeline({ defaults: { ease: 'power2.out', overwrite: 'auto' } })
      if (head) timeline.from(head, { autoAlpha: 0, y: -6, duration: MOTION.control }, 0)
      if (tabs) timeline.from(tabs, { autoAlpha: 0, y: -4, duration: MOTION.control }, 0.04)
      if (body?.length) {
        const stagger = Math.min(0.02, 0.08 / Math.max(1, body.length - 1))
        timeline.from(body, { autoAlpha: 0, y: 8, duration: MOTION.control, stagger }, 0.08)
      }
    })
  })

  return {
    MOTION,
    QuestionCard,
    ApprovalCard,
    RiskBadge,
    QuestionAnswerDetail,
    TodoRenderer,
    ToolDescriptionDisclosure,
    crtDisclosureTheme,
    controller,
    ElTooltip,
    RESULT_PREVIEW_LIMIT,
    RISK_LEVEL_LABEL,
    ToolFieldTree,
    activeQuestionCall,
    actualDescription,
    approval,
    batch,
    batchInfo,
    canBranch,
    copiedFieldKey,
    copyField,
    foldPosition,
    isQuestionCall,
    isQuestionTool,
    isReadFileTool,
    isSearchTool,
    isSkillTool,
    isSpawnTool,
    isTodoTool,
    isUserNode,
    nodeContent,
    nodeContentSegments,
    nodeDescription,
    nodeStatus,
    nodeTermination,
    nodeThinking,
    nodeTime,
    nodeTitle,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
    primaryInstruction,
    questionAnswer,
    questionArgs,
    readFileContent,
    readFileLineCount,
    readFilePath,
    readFilePreview,
    readFileRange,
    renderedActualDescription,
    renderedNodeContent,
    renderedNodeDescription,
    renderedNodeThinking,
    renderedPrimaryInstruction,
    renderedResult,
    renderedSkillContent,
    renderedSpawnPrompt,
    resultFields,
    resultTruncated,
    riskLevelOf,
    searchConfiguration,
    searchMode,
    searchPath,
    searchQuery,
    searchResult,
    secondaryFields,
    selectedCall,
    selectedStatus,
    skillResult,
    skinForNode,
    spawnPrompt,
    spawnRole,
    spawnWake,
    stepFold,
    terminationDisplay,
    thinkingOpen,
    todoSenseCall,
    toolBatchUsesTabs,
    toolGlyph,
    toolIcon,
    toolLabel,
    popoverRoot,
    effectiveMode,
  }
}
