import { nextTick, onBeforeUnmount, reactive, watch, type Ref, type WatchSource } from 'vue'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

interface ComposerMenuPositionOptions {
  editorRef: Ref<HTMLElement | null>
  commandMenuRef: Ref<HTMLElement | null>
  roleMenuRef: Ref<HTMLElement | null>
  showCommandMenu: Ref<boolean>
  showRoleMenu: Ref<boolean>
  activeCommandIndex: Ref<number>
  layoutDependencies: WatchSource[]
}

/** Keeps the teleported composer menus anchored above their editor. */
export function useComposerMenuPosition(options: ComposerMenuPositionOptions) {
  const commandMenuStyle = reactive({
    zIndex: OVERLAY_Z_INDEX.composerMenu,
    bottom: '0px',
    left: '0px',
    width: '390px',
    maxHeight: '280px',
  })

  function positionCommandMenu(): void {
    const editor = options.editorRef.value
    const menu = options.commandMenuRef.value ?? options.roleMenuRef.value
    if (!editor || !menu) return
    const editorRect = editor.getBoundingClientRect()
    const margin = 8
    const minWidth = 280
    const maxWidth = Math.min(420, window.innerWidth - margin * 2)
    const width = Math.max(minWidth, Math.min(maxWidth, editorRect.width))
    const left = Math.max(margin, Math.min(editorRect.left, window.innerWidth - width - margin))
    commandMenuStyle.bottom = `${window.innerHeight - editorRect.top + 6}px`
    commandMenuStyle.left = `${left}px`
    commandMenuStyle.width = `${width}px`
    commandMenuStyle.maxHeight = `${Math.min(280, Math.max(0, editorRect.top - margin - 6))}px`
  }

  watch(options.showCommandMenu, async (open) => {
    if (open) {
      await nextTick()
      positionCommandMenu()
    }
  })
  watch(options.showRoleMenu, async (open) => {
    if (open) {
      await nextTick()
      positionCommandMenu()
    }
  })
  watch(options.activeCommandIndex, () => {
    if (options.showCommandMenu.value) nextTick(positionCommandMenu)
  })
  watch(options.layoutDependencies, () => {
    if (options.showCommandMenu.value) nextTick(positionCommandMenu)
  })

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', positionCommandMenu)
    window.addEventListener('scroll', positionCommandMenu, true)
  }
  onBeforeUnmount(() => {
    if (typeof window === 'undefined') return
    window.removeEventListener('resize', positionCommandMenu)
    window.removeEventListener('scroll', positionCommandMenu, true)
  })

  return {
    commandMenuStyle,
    positionCommandMenu,
    editorRefFn: (element: HTMLElement | null) => (options.editorRef.value = element),
    commandMenuRefFn: (element: HTMLElement | null) => (options.commandMenuRef.value = element),
    roleMenuRefFn: (element: HTMLElement | null) => (options.roleMenuRef.value = element),
  }
}
