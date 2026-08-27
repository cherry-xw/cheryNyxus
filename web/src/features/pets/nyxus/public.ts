/** The only supported entry point for consumers outside the Nyxus bounded context. */
export { default as NyxusCore } from './components/NyxusCore.vue'
export { default as MessageBranchTree } from './components/MessageBranchTree.vue'
export { default as NyxusPianoStrip } from './components/NyxusPianoStrip.vue'
export { terminationDisplay } from './graph/termination'
export { terminalActionMode } from './composables/nodeInteraction'
export { isPianoRootSession } from './composables/pianoNotes'
export { accentForTheme } from './graph/nodeSkins'
export type { NodeSkinKey } from './graph/nodeSkins'
