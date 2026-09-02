<script setup lang="ts">
import type { WorkspaceWindowState } from '@/application/shell/public'

defineProps<{ window: WorkspaceWindowState }>()
</script>

<template>
  <article
    v-if="window.context.kind === 'diagnostic'"
    class="cyber-diagnostic"
    :class="`is-${window.context.severity}`"
  >
    <div class="diagnostic-code">
      <b>{{ window.context.severity === 'error' ? '0xDEAD' : '0x00FF' }}</b>
      <span>{{ window.context.code ?? window.context.source }}</span>
    </div>
    <div class="diagnostic-copy">
      <span>来源 / {{ window.context.source.toUpperCase() }}</span>
      <strong>{{ window.context.message }}</strong>
      <small>
        {{ window.context.severity === 'error' ? '真实运行故障已捕获，核心流程未被自动重试。' : '这是诊断事件，不代表协议或任务执行失败。' }}
      </small>
    </div>
    <footer><span>追踪已锁定</span><i /><span>非持久化表面</span></footer>
  </article>
</template>

<style scoped lang="less">
.cyber-diagnostic {
  height: 100%;
  display: grid;
  grid-template-columns: 118px 1fr;
  grid-template-rows: 1fr 32px;
  background:
    repeating-linear-gradient(0deg, transparent 0 5px, color-mix(in srgb, var(--danger) 4%, transparent) 6px),
    var(--cyber-window-bg);
  font-family: var(--font-mono);
}

.diagnostic-code {
  display: grid;
  align-content: center;
  justify-items: center;
  border-right: 1px solid var(--cyber-line-soft);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

.diagnostic-code b {
  color: var(--danger);
  font-size: 22px;
  font-weight: 600;
}

.diagnostic-code span,
.diagnostic-copy span,
.diagnostic-copy small,
footer {
  color: color-mix(in srgb, var(--ink) 56%, transparent);
  font-size: 9px;
  letter-spacing: 0.08em;
}

.diagnostic-copy {
  min-width: 0;
  display: grid;
  align-content: center;
  gap: 13px;
  padding: 20px;
}

.diagnostic-copy strong {
  overflow: auto;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

footer {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border-top: 1px solid var(--cyber-line-soft);
}

footer i {
  height: 1px;
  flex: 1;
  background: var(--cyber-line-soft);
}

.is-warning .diagnostic-code {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
}

.is-warning .diagnostic-code b {
  color: var(--warning);
}
</style>
