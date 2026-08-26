import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Ref } from 'vue'
import { noteFrequency } from './pianoNotes'
import { usePianoAudio } from './usePianoAudio'

/**
 * 钢琴键盘映射 composable（VirtualPiano 两行键位排版）。
 *
 * 低八度（C4..B4 = MIDI 60..71）：白键 Z X C V B N M，黑键 S D G H J；
 * 高八度（C5..B5 = MIDI 72..83）：白键 Q W E R T Y U，黑键 2 3 5 6 7。
 *
 * - 用 `KeyboardEvent.code`（物理键位）匹配，规避键盘布局/输入法差异。
 * - 输入控件（input/textarea/select/[contenteditable]）内的按键忽略，弹琴不干扰打字。
 * - `e.repeat` 忽略；命中键 preventDefault + 播放 `noteFrequency(midi)`。
 * - 仅在组件挂载期间监听（浮层打开才弹琴）；AudioContext 由 usePianoAudio 在手势链内懒建解锁。
 */

/** VirtualPiano 两行键位表：`KeyboardEvent.code` → MIDI。 */
export const PIANO_KEY_MAP: Readonly<Record<string, number>> = {
  // 低八度白键（C4..B4）
  KeyZ: 60,
  KeyX: 62,
  KeyC: 64,
  KeyV: 65,
  KeyB: 67,
  KeyN: 69,
  KeyM: 71,
  // 低八度黑键（C#4..A#4）
  KeyS: 61,
  KeyD: 63,
  KeyG: 66,
  KeyH: 68,
  KeyJ: 70,
  // 高八度白键（C5..B5）
  KeyQ: 72,
  KeyW: 74,
  KeyE: 76,
  KeyR: 77,
  KeyT: 79,
  KeyY: 81,
  KeyU: 83,
  // 高八度黑键（C#5..A#5）
  Digit2: 73,
  Digit3: 75,
  Digit5: 78,
  Digit6: 80,
  Digit7: 82,
}

const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]'

export function usePianoKeyboard(): {
  pressedMidis: Ref<ReadonlySet<number>>
} {
  const audio = usePianoAudio()
  const pressedMidis: Ref<ReadonlySet<number>> = ref(new Set())
  const pressed = new Map<string, number>()

  function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return !!target.closest(EDITABLE_SELECTOR)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return
    if (isEditableTarget(event.target)) return
    const midi = PIANO_KEY_MAP[event.code]
    if (midi === undefined) return
    event.preventDefault()
    pressed.set(event.code, midi)
    pressedMidis.value = new Set(pressed.values())
    void audio.play(noteFrequency(midi))
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (!pressed.has(event.code)) return
    pressed.delete(event.code)
    pressedMidis.value = new Set(pressed.values())
  }

  function onWindowBlur(): void {
    if (pressed.size === 0) return
    pressed.clear()
    pressedMidis.value = new Set()
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onWindowBlur)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('blur', onWindowBlur)
  })

  return { pressedMidis }
}
