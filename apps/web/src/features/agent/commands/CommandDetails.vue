<script setup lang="ts">
import { useCommandDetails } from './useCommandDetails'
import { commandStatusLabels, sourceLabels, logStatusLabels, commandTime } from './model'
const props = defineProps<{ commandId: string }>()
const { commands, command, log, text, tab, stopError, stopMessage, canStop, stop, read } = useCommandDetails(props.commandId)
</script>

<template>
  <section class="command-details" aria-label="命令详情">
    <template v-if="command">
      <header><h3>{{ command.description || '命令详情' }}</h3><button type="button" :disabled="!canStop" @click="stop">{{ command.status === 'cancel_requested' ? '等待停止确认' : '停止此命令' }}</button></header>
      <p v-if="stopError" role="alert">{{ stopError }}</p><p v-if="stopMessage" role="status">{{ stopMessage }}</p>
      <pre class="command-source">{{ command.command }}</pre>
      <dl>
        <div><dt>状态 / 来源</dt><dd>{{ commandStatusLabels[command.status] }} · {{ sourceLabels[command.sourceKind] }}</dd></div>
        <div><dt>会话 / 运行</dt><dd>{{ command.chatId }} / {{ command.runId ?? '未关联运行' }}</dd></div>
        <div><dt>工作目录</dt><dd>{{ command.workdir ?? '未提供' }}</dd></div>
        <div><dt>进程 / 任务标识</dt><dd>{{ command.executionId ?? '尚未登记' }}</dd></div>
        <div><dt>开始 / 结束</dt><dd>{{ commandTime(command.startedAt) }} / {{ commandTime(command.endedAt) }}</dd></div>
        <div><dt>退出码 / 信号</dt><dd>{{ command.exitCode ?? '未确认' }} / {{ command.signal ?? '无记录' }}</dd></div>
        <div><dt>原始日志</dt><dd>{{ logStatusLabels[command.logStatus] }} · 压缩后 {{ (command.storedCompressedBytes / 1024).toFixed(1) }} KiB</dd></div>
      </dl>
      <p v-if="command.logTailUnconfirmed" class="warning">日志尾部未确认；无法知道有多少输出未送达，不能把当前记录当作完整日志。</p>
      <nav aria-label="日志视图"><button type="button" :aria-pressed="tab === 'original'" @click="tab = 'original'">原始日志</button><button type="button" :aria-pressed="tab === 'summary'" @click="tab = 'summary'">相似日志摘要</button></nav>
      <p v-if="log?.error" role="alert">{{ log.error }}</p>
      <section v-if="tab === 'original'" aria-label="原始日志">
        <div class="log-navigation">
          <button type="button" :disabled="log?.loading || !commands.online" @click="read('first')">开头</button>
          <button type="button" :disabled="log?.loading || !commands.online || !(log?.chunks[0]?.sequence && log.chunks[0].sequence > 1)" @click="read('older')">上一页</button>
          <button type="button" :disabled="log?.loading || !commands.online || !log?.chunks.length" @click="read('newer')">下一页</button>
          <button type="button" :disabled="log?.loading || !commands.online" @click="read('latest')">最新并跟随</button>
          <span role="status">{{ log?.loading ? '正在补读…' : log?.follow ? '跟随最新输出' : '查看历史页，已暂停跟随' }}</span>
        </div>
        <p v-if="log?.trimmed" class="warning">浏览器仅显示最近 1 MiB 或 512 块；更早的已保留内容可分页查看。</p>
        <ul v-if="log?.gaps.length" class="warning"><li v-for="gap in log.gaps" :key="`${gap.sequenceStart}:${gap.sequenceEnd}`">日志缺失：第 {{ gap.sequenceStart }}–{{ gap.sequenceEnd }} 块，约 {{ gap.lineEnd - gap.lineStart }} 个换行 / {{ gap.byteEnd - gap.byteStart }} 字节，原文不可恢复。</li></ul>
        <pre class="original-log" tabindex="0" aria-label="原始命令输出">{{ text || (log?.loading ? '正在读取…' : '暂无已保留输出。') }}</pre>
      </section>
      <section v-else aria-label="相似日志摘要">
        <p>摘要会合并相似行，不是完整日志；摘要失败不影响命令执行。</p>
        <template v-if="command.drainSummary">
          <p>已分析 {{ command.drainSummary.lineCount }} 行；跳过 {{ command.drainSummary.skippedLineCount }} 行，截短 {{ command.drainSummary.truncatedLineCount }} 行，已移出模板 {{ command.drainSummary.retiredLineCount }} 行。</p>
          <p v-if="command.drainSummary.status === 'partial' || command.drainSummary.status === 'failed'" class="warning">摘要不完整或生成失败，请结合原始日志判断。</p>
          <details v-for="item in command.drainSummary.templates" :key="`${item.stream}:${item.id}`"><summary>[{{ item.stream }}] {{ item.count }} 次 · {{ item.template }}</summary><pre v-for="(sample, index) in item.samples" :key="index">{{ sample }}</pre></details>
        </template>
        <p v-else>暂无摘要。</p>
      </section>
    </template>
    <p v-else role="status">{{ log?.error || '正在读取命令详情…' }}</p>
  </section>
</template>

<style scoped>
.command-details { min-width: 0; overflow: auto; padding-right: 4px; }
header, nav, .log-navigation { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
header { justify-content: space-between; } h3 { margin: 0; font-size: 16px; font-weight: 600; }
button { padding: 6px 10px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 0; color: var(--ink); font: inherit; cursor: pointer; }
button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent-soft); }
button:disabled { cursor: default; opacity: .6; }
button:focus-visible, pre:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
dl { margin: 12px 0; } dl > div { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--border); }
dd { margin: 0; overflow-wrap: anywhere; } p { margin: 8px 0; }
nav { margin: 12px 0; } pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 400 14px/1.6 var(--font-mono); }
.command-source, .original-log { padding: 12px; background: var(--surface); border: 1px solid var(--border); }
.original-log { overflow: auto; max-height: 55vh; min-height: 120px; }
.warning { color: var(--warning); } [role='alert'] { color: var(--danger); }
details { margin: 8px 0; padding: 8px; border: 1px solid var(--border); overflow-wrap: anywhere; } summary { cursor: pointer; }
</style>
