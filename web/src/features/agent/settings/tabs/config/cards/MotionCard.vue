<script setup lang="ts">
import { useMotionPreference, type MotionPreference } from '@/composables/useMotionPreference'

defineProps<{ no: number }>()
const { preference, setMotionPreference } = useMotionPreference()
const options: { value: MotionPreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'full', label: '完整' },
  { value: 'reduced', label: '精简' },
]
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span> INTERFACE
  </div>
  <h3>界面动效</h3>
  <div class="motion-options" role="group" aria-label="界面动效强度">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      :aria-pressed="preference === option.value"
      @click="setMotionPreference(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
  <p>精简模式减少位移与装饰动画；跟随系统会采用设备的减少动态效果偏好。</p>
  <p>选择立即生效并保存在当前客户端，同源窗口同步，无需点击保存。</p>
</template>

<style scoped>
.motion-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
button {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--surface-soft);
  color: var(--ink);
  font: 400 12px/1.5 var(--font-ui, sans-serif);
  cursor: pointer;
}
button[aria-pressed='true'],
button:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
p {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink);
}
</style>
