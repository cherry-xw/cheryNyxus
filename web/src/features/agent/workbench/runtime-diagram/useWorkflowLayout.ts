import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { workflowLayout } from './model'

export function useWorkflowLayout(
  enabled: Ref<boolean>,
  vertical: Ref<boolean>,
  paper: Ref<boolean>,
) {
  const host = ref<HTMLElement>()
  const composer = ref<HTMLElement>()
  const width = ref(0),
    height = ref(0),
    composerHeight = ref(0)
  const observer = new ResizeObserver(() => measure())
  function measure() {
    width.value = host.value?.clientWidth ?? 0
    height.value = host.value?.clientHeight ?? 0
    composerHeight.value = enabled.value ? (composer.value?.offsetHeight ?? 0) : 0
  }
  watch(
    [host, composer, enabled],
    () => {
      observer.disconnect()
      if (host.value) observer.observe(host.value)
      if (composer.value) observer.observe(composer.value)
      measure()
    },
    { flush: 'post' },
  )
  const layout = computed(() =>
    workflowLayout(
      Math.max(0, width.value - 64),
      Math.max(0, height.value - composerHeight.value - (composerHeight.value ? 8 : 0)),
      vertical.value,
      paper.value,
    ),
  )
  const style = computed(() =>
    enabled.value
      ? {
          '--workflow-composer-height': `${composerHeight.value ? composerHeight.value + 8 : 0}px`,
          '--workflow-width': `${layout.value.width}px`,
          '--workflow-height': `${layout.value.height}px`,
          '--workflow-flow-height': `${layout.value.flowHeight}px`,
          '--workflow-tree-width': `${layout.value.treeWidth}px`,
          '--workflow-paper-width': `${layout.value.paperWidth}px`,
        }
      : {},
  )
  onBeforeUnmount(() => observer.disconnect())
  return { host, composer, style }
}
