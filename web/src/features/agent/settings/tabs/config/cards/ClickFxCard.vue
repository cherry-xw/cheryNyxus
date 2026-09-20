<script setup lang="ts">
/** 鼠标点击特效（ba-click-fx）开关卡：偏好经 localStorage + BroadcastChannel 立即生效并跨窗口同步。 */
import { useClickFxPreference } from '@/composables/useClickFxPreference'

defineProps<{ no: number }>()
const { enabled, setClickFxEnabled } = useClickFxPreference()
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span> INTERFACE
  </div>
  <h3>点击特效</h3>
  <div class="clickfx-options" role="group" aria-label="鼠标点击特效开关">
    <button type="button" :aria-pressed="enabled" @click="setClickFxEnabled(true)">开启</button>
    <button type="button" :aria-pressed="!enabled" @click="setClickFxEnabled(false)">关闭</button>
  </div>
  <p>点击、拖拽与拖尾时显示蔚蓝档案风格的霓虹光效，覆盖全部界面窗口。</p>
  <p>
    开启界面动效的「精简」模式时会自动停用；选择立即生效并保存在当前客户端，同源窗口同步，无需点击保存。
  </p>
</template>

<style scoped>
.clickfx-options {
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
  font: 400 14px/1.5 var(--font-ui, sans-serif);
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
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
}
</style>
