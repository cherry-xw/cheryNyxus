<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, Fragment, useId, nextTick, type VNode } from 'vue'
const props = defineProps<{ modelValue?: unknown; value?: unknown; disabled?: boolean; label?: string }>()
const emit = defineEmits(['update:modelValue', 'change'])
const slots = defineSlots<{ default?: () => VNode[] }>()
const root = ref<HTMLElement>(), opened = ref(false)
function flatten(nodes: any[]): any[] { return nodes.flatMap(n => n.type === Fragment ? flatten(n.children || []) : n.type === 'option' ? [n] : []) }
const options = () => flatten(slots.default?.() || [])
const selected = computed(() => props.modelValue ?? props.value ?? '')
const listId = useId()
function text(n: any): string { return typeof n.children === 'string' ? n.children : Array.isArray(n.children) ? n.children.map((c: any) => typeof c === 'string' ? c : text(c)).join('') : '' }
function choose(n: any) { if (props.disabled || root.value?.closest('fieldset:disabled') || n.props?.disabled) return; const v = n.props?.value ?? text(n); emit('update:modelValue', v); emit('change', { target: { value: v } }); opened.value = false }
let start: { x: number; y: number } | null = null
let lastTouch = 0
function press(e: PointerEvent) { if (e.pointerType === 'touch') start = { x: e.clientX, y: e.clientY } }
function release(e: PointerEvent, action: () => void) {
  if (e.pointerType !== 'touch' || !start) return
  const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8
  start = null; lastTouch = Date.now()
  if (!moved) action()
}
function click(action: () => void) { if (Date.now() - lastTouch > 700) action() }
function toggle() { if (!props.disabled && !root.value?.closest('fieldset:disabled')) opened.value = !opened.value }
function outside(e: PointerEvent) { if (!root.value?.contains(e.target as Node)) opened.value = false }
function close() { opened.value = false; root.value?.querySelector('button')?.focus() }
async function key(event: KeyboardEvent) {
  if (event.key === 'Escape' && opened.value) { event.preventDefault(); event.stopPropagation(); close(); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || props.disabled || root.value?.closest('fieldset:disabled')) return
  event.preventDefault()
  opened.value = true
  await nextTick()
  const buttons = Array.from(root.value?.querySelectorAll<HTMLButtonElement>('.dropdown-list button:not(:disabled)') || [])
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (current + 1) % buttons.length : current <= 0 ? buttons.length - 1 : current - 1
  buttons[index]?.focus()
}
onMounted(() => document.addEventListener('pointerdown', outside))
onUnmounted(() => document.removeEventListener('pointerdown', outside))
</script>
<template>
  <div ref="root" class="dropdown" @keydown="key" @focusout="!root?.contains($event.relatedTarget as Node) && (opened = false)">
    <button type="button" :disabled="disabled" :aria-expanded="opened" :aria-controls="listId" :aria-label="label ? `${label}：${text(options().find(n => (n.props?.value ?? text(n)) === selected) || { children: String(selected || '请选择') })}` : undefined" @pointerdown="press" @pointerup="release($event, toggle)" @pointercancel="start = null; lastTouch = Date.now()" @click="click(toggle)">{{ text(options().find(n => (n.props?.value ?? text(n)) === selected) || { children: String(selected || '请选择') }) }} <span aria-hidden="true">▾</span></button>
    <div v-if="opened && !disabled" :id="listId" class="dropdown-list">
      <button v-for="(n, i) in options()" :key="i" type="button" :disabled="n.props?.disabled" :aria-pressed="(n.props?.value ?? text(n)) === selected" :class="{ chosen: (n.props?.value ?? text(n)) === selected }" @pointerdown="press" @pointerup="release($event, () => choose(n))" @pointercancel="start = null; lastTouch = Date.now()" @click="click(() => { choose(n); close() })">{{ text(n) }}</button>
    </div>
  </div>
</template>
<style scoped>
.dropdown{position:relative;min-width:0;width:100%}.dropdown>button{width:100%;display:flex;justify-content:space-between;text-align:left;margin:0;white-space:normal}.dropdown-list{position:absolute;top:100%;left:0;right:0;z-index:30;max-height:240px;overflow-y:auto;overscroll-behavior:contain;touch-action:pan-y;background:#fff;border:1px solid #666;box-shadow:0 3px 8px #0004}.dropdown-list button{display:block;width:100%;text-align:left;border:0;background:#fff;margin:0;padding:8px;touch-action:pan-y}.dropdown-list button:hover,.dropdown-list button.chosen{background:#d7e5f8}
</style>
