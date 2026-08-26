<script setup lang="ts">
/**
 * NyxusPianoStrip：工作台节点树彩蛋浮层里的标准钢琴。
 * 固定 2 八度 24 键（C4..B5，白 14 + 黑 10），纯弹奏、无任何会话映射。
 * - 指针点击键发声；键盘映射弹奏（usePianoKeyboard，输入控件内按键忽略）。
 * - 浮层自包含关闭：点外部 / ✕ / Esc 触发 `close`，父级 v-if 移除。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  layoutPianoKeys,
  noteName,
  type PianoKeyGeom,
} from '../composables/pianoNotes'
import { usePianoAudio } from '../composables/usePianoAudio'
import { usePianoKeyboard, PIANO_KEY_MAP } from '../composables/usePianoKeyboard'

const emit = defineEmits<{ close: [] }>()

const audio = usePianoAudio()
const { pressedMidis } = usePianoKeyboard()

/** 固定 24 键：C4..B5（白 14 + 黑 10，轨宽 448px）。 */
const layout = layoutPianoKeys(24)
const keys = layout.keys

// MIDI → 物理键位字母（键面提示；反查 PIANO_KEY_MAP，KeyZ→Z / Digit2→2）。
const KEY_HINT_BY_MIDI: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(PIANO_KEY_MAP).map(([code, midi]) => [
    midi,
    code.replace(/^Key/, '').replace(/^Digit/, ''),
  ]),
) as Readonly<Record<number, string>>

/** 指针按下的键索引（白/黑键按压高亮用）。 */
const pressedKeyId = ref<number | null>(null)
let pressedPointerId = -1

function onKeyDown(e: PointerEvent, key: PianoKeyGeom): void {
  pressedKeyId.value = key.index
  pressedPointerId = e.pointerId
  window.addEventListener('pointerup', onKeyUp)
  window.addEventListener('pointercancel', onKeyUp)
  void audio.play(key.freq)
}

function onKeyUp(e: PointerEvent): void {
  if (e.pointerId !== pressedPointerId) return
  pressedKeyId.value = null
  pressedPointerId = -1
  window.removeEventListener('pointerup', onKeyUp)
  window.removeEventListener('pointercancel', onKeyUp)
}

/** 按压高亮：指针按下 或 键盘按下（pressedMidis）命中该键。 */
function isPressed(key: PianoKeyGeom): boolean {
  return key.index === pressedKeyId.value || pressedMidis.value.has(key.midi)
}

function hintOf(key: PianoKeyGeom): string {
  return KEY_HINT_BY_MIDI[key.midi] ?? ''
}

// ── 浮层自包含关闭：点外部 / ✕ / Esc ──
const rootRef = ref<HTMLElement | null>(null)

function onWindowPointerDown(e: PointerEvent): void {
  const root = rootRef.value
  if (!root) return
  if (e.target instanceof Node && root.contains(e.target)) return
  emit('close')
}

function onWindowKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown)
  window.addEventListener('keydown', onWindowKeyDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('keydown', onWindowKeyDown)
  window.removeEventListener('pointerup', onKeyUp)
  window.removeEventListener('pointercancel', onKeyUp)
})
</script>

<template>
  <div ref="rootRef" class="piano-keyboard" role="dialog" aria-label="Nyxus 钢琴彩蛋">
    <header class="piano-panel-head">
      <button
        type="button"
        class="piano-panel-action"
        :class="{ 'is-active': audio.muted.value }"
        :aria-label="audio.muted.value ? '开启琴键音' : '静音琴键音'"
        :title="audio.muted.value ? '开启琴键音' : '静音琴键音'"
        :aria-pressed="audio.muted.value"
        @click="audio.toggleMute"
      >
        <span aria-hidden="true">{{ audio.muted.value ? '∅' : '♪' }}</span>
      </button>
      <span class="piano-panel-title">NYXUS PIANO · C4–B5</span>
      <button
        type="button"
        class="piano-close"
        aria-label="关闭钢琴"
        title="关闭 (Esc)"
        @click="emit('close')"
      >
        <span aria-hidden="true">×</span>
      </button>
    </header>
    <div class="piano-stage">
      <div class="piano-track" :style="{ width: layout.trackWidth + 'px' }">
        <button
          v-for="key in keys"
          :key="key.index"
          type="button"
          class="piano-key"
          :class="[key.isBlack ? 'is-black' : 'is-white', { 'is-pressed': isPressed(key) }]"
          :style="{
            left: key.left + 'px',
            width: key.width + 'px',
            height: key.height + 'px',
            zIndex: String(key.z),
          }"
          :aria-label="`${noteName(key.midi)}（${hintOf(key)}）`"
          @pointerdown="onKeyDown($event, key)"
        >
          <span class="key-hint" :class="key.isBlack ? 'is-on-black' : 'is-on-white'">
            {{ hintOf(key) }}
          </span>
        </button>
      </div>
    </div>
    <footer class="piano-keyboard-hint">
      键盘弹奏：低八度 Z X C V B N M（黑键 S D G H J）· 高八度 Q W E R T Y U（黑键 2 3 5 6 7）
    </footer>
  </div>
</template>

<style scoped lang="less" src="./NyxusPianoStrip.styles.less"></style>
