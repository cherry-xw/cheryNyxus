<script setup lang="ts">
import { useCommandMonitor } from './useCommandMonitor'
import { commandStatusLabels, sourceLabels, commandTime } from './model'
import CommandDetails from './CommandDetails.vue'

const props = defineProps<{ chatId?: string }>()
const { commands, view, items, selected, scope, refresh, more } = useCommandMonitor(() => props.chatId)
</script>

<template>
  <section class="command-monitor" aria-label="Agent 命令监控">
    <header class="command-toolbar">
      <span>{{ chatId ? '当前会话及子会话' : '当前账号有权查看的全部会话' }}</span>
      <label>显示范围
        <select :value="view?.query.scope ?? 'active'" :disabled="view?.loading" @change="scope(($event.target as HTMLSelectElement).value as 'active' | 'history' | 'all')">
          <option value="active">执行中的命令</option><option value="history">历史命令</option><option value="all">全部命令</option>
        </select>
      </label>
      <button type="button" :disabled="view?.loading || !commands.online" @click="refresh">刷新</button>
    </header>
    <p v-if="!commands.online" role="status">连接已断开；以下是断开前的信息，重新连接后补读保留日志。</p>
    <p v-if="commands.subscriptionError" role="alert">实时更新未接通：{{ commands.subscriptionError }}</p>
    <p v-if="view?.error" role="alert">{{ view.error }}</p>
    <div class="command-columns">
      <section class="command-list" aria-label="命令列表" :aria-busy="view?.loading">
        <p v-if="!items.length" role="status">{{ view?.loading ? '正在读取命令…' : '当前范围没有命令。' }}</p>
        <ul v-else>
          <li v-for="item in items" :key="item.commandId">
            <button type="button" :aria-pressed="selected === item.commandId" @click="selected = item.commandId">
              <span>{{ item.description || sourceLabels[item.sourceKind] }}</span>
              <code>{{ item.command }}</code>
              <span>{{ commandStatusLabels[item.status] }} · {{ commandTime(item.startedAt) }}</span>
            </button>
          </li>
        </ul>
        <button v-if="view?.cursor" type="button" :disabled="view.loading || !commands.online" @click="more">读取更早的命令</button>
        <p v-if="items.length >= 500">列表仅保留本次最近读取的 500 条记录。</p>
      </section>
      <CommandDetails v-if="selected" :key="selected" :command-id="selected" />
      <p v-else class="command-empty">选择命令查看详情、原始日志或相似日志摘要。</p>
    </div>
  </section>
</template>

<style scoped>
.command-monitor { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 16px; gap: 12px; background: var(--panel); color: var(--ink); font: 400 14px/1.6 var(--font-ui); overflow: auto; }
.command-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.command-toolbar label { display: flex; align-items: center; gap: 8px; }
button, select { padding: 6px 10px; border: 1px solid var(--border-strong); border-radius: 0; background: var(--surface); color: var(--ink); font: inherit; }
button { cursor: pointer; } button:disabled { cursor: default; opacity: .6; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.command-columns { display: grid; grid-template-columns: minmax(220px, 34%) minmax(0, 1fr); gap: 16px; flex: 1; min-height: 0; }
.command-list { overflow: auto; min-width: 0; }
ul { padding: 0; margin: 0 0 12px; list-style: none; }
li + li { margin-top: 8px; }
li button { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; overflow-wrap: anywhere; }
li button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-soft); }
code { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-family: var(--font-mono); }
p { margin: 0; } [role='alert'] { color: var(--danger); }
@container (max-width: 640px) { .command-columns { grid-template-columns: 1fr; } .command-list { max-height: 40vh; } }
</style>
