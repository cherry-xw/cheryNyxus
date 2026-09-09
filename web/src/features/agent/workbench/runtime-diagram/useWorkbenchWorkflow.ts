import { computed, ref, watch } from 'vue'
import type { useWorkbenchDialogController } from '../useWorkbenchDialogController'
import { useWorkflowLayout } from './useWorkflowLayout'

export function useWorkbenchWorkflow(controller: ReturnType<typeof useWorkbenchDialogController>) {
  const workflowOpen = ref(false)
  const workflowEnabled = computed(
    () =>
      workflowOpen.value && !controller.liteViewVisible.value && !!controller.treeRootChatId.value,
  )
  const workflowVertical = computed(() => controller.presentationMode.value === 'vertical-classic')
  const {
    host: workflowHost,
    composer: workflowComposer,
    style: workflowStyle,
  } = useWorkflowLayout(workflowEnabled, workflowVertical, controller.paperMode)
  watch(
    () => !!controller.win.value,
    (open) => {
      if (!open) workflowOpen.value = false
    },
  )
  return {
    workflowOpen,
    workflowEnabled,
    workflowVertical,
    workflowHost,
    workflowComposer,
    workflowStyle,
  }
}
