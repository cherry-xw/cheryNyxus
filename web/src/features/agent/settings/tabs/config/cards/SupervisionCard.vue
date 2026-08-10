<script setup lang="ts">
/** SupervisionCard：默认监管等级 + 流式输出开关。 */
import type { GlobalConfigDto } from '@/services/agentApi'
import { SUPERVISIONS, SUPERVISION_LABEL } from '../../../config/constants'

defineProps<{ global: GlobalConfigDto; no: number }>()
</script>

<template>
  <div class="block-heading">
    <div>
      <div class="block-kicker">
        <span class="kicker-no">{{ no }}</span>GUARD MODE
      </div>
      <h3>默认监管</h3>
    </div>
    <button
      type="button"
      class="stream-chip"
      :class="{ active: global.stream }"
      :aria-pressed="global.stream"
      :title="
        global.stream
          ? '流式输出已开启，点击改为完整返回'
          : '流式输出已关闭，点击改为边生成边返回'
      "
      @click="global.stream = !global.stream"
    >
      <span>≋</span><b>流式</b><small>{{ global.stream ? '即时' : '整段' }}</small>
    </button>
  </div>
  <div class="supervision-deck">
    <button
      v-for="s in SUPERVISIONS"
      :key="s"
      type="button"
      :class="{ active: global.supervision === s }"
      @click="global.supervision = s"
    >
      <span>{{ s === 'auto' ? '⚡' : s === 'smart' ? '◉' : '✋' }}</span
      ><b>{{ SUPERVISION_LABEL[s] }}</b>
    </button>
  </div>
  <p class="deck-note">自动更流畅；智能：安全操作自动执行，敏感操作先询问；手动最谨慎。</p>
</template>

<style scoped lang="less">
@import './shared-neon.less';

.block-heading {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 27px;
}
.block-heading > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.supervision-deck {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
}
.supervision-deck button {
  min-height: 50px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid rgba(99, 102, 241, 0.13);
  border-radius: 10px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  cursor: pointer;
  transition: 0.16s ease;
  span {
    font-size: 17px;
  }
  b {
    font-size: 10px;
  }
  &.active {
    border-color: rgba(96, 165, 250, 0.75);
    color: #4338ca;
    background: linear-gradient(145deg, rgba(224, 242, 254, 0.8), rgba(243, 232, 255, 0.72));
    box-shadow:
      0 0 0 1px rgba(94, 234, 255, 0.25),
      0 0 13px rgba(99, 102, 241, 0.22),
      inset 0 -2px 8px rgba(217, 70, 233, 0.08);
    transform: translateY(-1px);
  }
}
[data-theme='dark'] .supervision-deck button.active {
  border-color: rgba(96, 165, 250, 0.6);
  color: #a5b4fc;
  background: linear-gradient(145deg, color-mix(in srgb, #6366f1 22%, var(--surface)), color-mix(in srgb, #a855f7 16%, var(--surface)));
}
.deck-note {
  position: relative;
  margin: 0;
  font-size: 9px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
</style>
