<script setup lang="ts">
/**
 * CommandRenderer：execute_command 专用渲染器。
 *
 * UI 设计：
 * - 头部：💻 图标 + "执行命令" + 内联 meta（耗时 · PID · 退出码，灰色小字） + 状态指示
 * - 命令区（args）：
 *   - 说明（深色加粗，置于第一行）
 *   - 命令行（<code> 样式 + 复制按钮）
 * - 输出区（可折叠，默认收起）：
 *   - 成功：显示 stdout/stderr（截断到 500 行）
 *   - 错误：红色高亮 error 信息
 *   - 超时：显示 timeout 提示 + 日志路径（输出区下方小字）
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { RendererProps, ExecuteCommandArgs, ExecuteCommandResult } from '../types'
import { CopyDocument, DocumentChecked } from '@element-plus/icons-vue'

const props = defineProps<RendererProps>()

const showOutput = ref(props.defaultExpanded ?? false)

// 解析参数
const parsedArgs = computed<ExecuteCommandArgs | null>(() => {
  try {
    const raw =
      typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args ?? {})
    const obj = JSON.parse(raw) as ExecuteCommandArgs
    if (obj.command) return obj
    return null
  } catch (e) {
    console.warn('[CommandRenderer] args 解析失败', e)
    return null
  }
})

// 解析结果（后端返回字符串格式）
const parsedResult = computed<ExecuteCommandResult | null>(() => {
  if (!props.call.result || typeof props.call.result !== 'string') return null
  try {
    const text = props.call.result as string

    // 正则提取字段（key 与后端 bash.ts formatBashResult 中文文案严格一致，见 docs/web/renderer.md）
    const statusMatch = text.match(/状态:\s*(\w+)/)
    const pidMatch = text.match(/进程ID:\s*(\d+)/)
    const exitCodeMatch = text.match(/退出码:\s*(\d+)/)
    const durationMatch = text.match(/执行时长:\s*(\d+)ms/)
    const outputMatch = text.match(/\[输出\]\r?\n([\s\S]*)/)
    const logPathMatch = text.match(/日志路径:\s*([^\n]+)/)
    const messageMatch = text.match(/说明:\s*([^\n]+)/)

    return {
      status: (statusMatch?.[1] ?? 'error') as ExecuteCommandResult['status'],
      pid: pidMatch?.[1] ? parseInt(pidMatch[1], 10) : 0,
      exitCode: exitCodeMatch?.[1] ? parseInt(exitCodeMatch[1], 10) : undefined,
      duration: durationMatch?.[1] ? parseInt(durationMatch[1], 10) : 0,
      // 后端 result 不输出 command/description，从 args 取（fallback 降级 JSON）
      command: parsedArgs.value?.command ?? '',
      description: parsedArgs.value?.description ?? '',
      output: outputMatch?.[1] ?? '',
      // 日志路径行尾带「（详细信息使用 read_file 读取）」说明，剔除之
      logPath: logPathMatch?.[1]?.split('（')[0]?.trim(),
      message: messageMatch?.[1]?.trim(),
    }
  } catch (e) {
    console.warn('[CommandRenderer] result 解析失败', e)
    return null
  }
})

// 输出截断（最多 500 行）
const OUTPUT_MAX_LINES = 500
const truncatedOutput = computed(() => {
  const output = parsedResult.value?.output ?? ''
  const lines = output.split('\n')
  if (lines.length <= OUTPUT_MAX_LINES) {
    return { text: output, truncated: false, totalLines: lines.length }
  }
  return {
    text: lines.slice(0, OUTPUT_MAX_LINES).join('\n'),
    truncated: true,
    totalLines: lines.length,
  }
})

// 状态字形和样式
const statusGlyph = computed(() => {
  switch (props.call.status) {
    case 'running':
      return '⋯'
    case 'done':
      return parsedResult.value?.status === 'error' ? '✗' : '✓'
    case 'error':
      return '✗'
    default:
      return '?'
  }
})

/** 耗时格式化：<1000ms 显示 `Nms`，≥1000ms 显示 `X.Xs`。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/** head 行内联 meta 文本（耗时/PID/退出码）；仅当 result 存在时输出。 */
const headMetaText = computed<string>(() => {
  const r = parsedResult.value
  if (!r) return ''
  const parts: string[] = []
  if (r.duration) parts.push(`耗时 ${formatDuration(r.duration)}`)
  if (r.pid) parts.push(`PID ${r.pid}`)
  if (r.exitCode !== undefined) parts.push(`退出码 ${r.exitCode}`)
  return parts.join(' · ')
})

const statusClass = computed(() => {
  if (props.call.status === 'error' || parsedResult.value?.status === 'error') {
    return 'status-error'
  }
  if (props.call.status === 'running') {
    return 'status-running'
  }
  return 'status-done'
})

// 降级显示
const fallback = computed(() => {
  if (!parsedArgs.value) {
    return JSON.stringify(props.call.args ?? {}, null, 2)
  }
  return ''
})

// 复制命令到剪贴板（仅 command 文本）；成功后瞬时反馈 1.2s
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | undefined

async function copyCommand(): Promise<void> {
  const cmd = parsedArgs.value?.command ?? ''
  if (!cmd) return
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(cmd)
    } else {
      // 降级：execCommand（兼容非 HTTPS / 旧 Electron webview）
      const ta = document.createElement('textarea')
      ta.value = cmd
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copied.value = false
    }, 1200)
  } catch (e) {
    console.warn('[CommandRenderer] 复制失败', e)
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <div class="cmd-box" :class="statusClass">
    <div class="cmd-head">
      <span class="cmd-icon" aria-hidden="true">💻</span>
      <span class="cmd-name">执行命令</span>
      <span v-if="headMetaText" class="cmd-meta-inline">{{ headMetaText }}</span>
      <span v-else style="flex: 1" />
      <span class="cmd-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 命令行 -->
    <div v-if="parsedArgs" class="cmd-section">
      <div v-if="parsedArgs.description" class="cmd-row cmd-row-desc">
        <span class="cmd-label">说明</span>
        <span class="cmd-desc">{{ parsedArgs.description }}</span>
      </div>
      <div class="cmd-row">
        <span class="cmd-label">命令</span>
        <div class="cmd-code-wrap">
          <code class="cmd-code">{{ parsedArgs.command }}</code>
          <button
            type="button"
            class="copy-btn"
            :class="{ copied: copied }"
            :aria-label="copied ? '已复制' : '复制命令'"
            @click="copyCommand"
          >
            <el-icon>
              <DocumentChecked v-if="copied" />
              <CopyDocument v-else />
            </el-icon>
          </button>
        </div>
      </div>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="cmd-fallback">{{ fallback }}</pre>

    <!-- 输出区（可折叠） -->
    <div v-if="parsedResult" class="cmd-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showOutput"
        @click="showOutput = !showOutput"
      >
        <span class="caret" :class="{ open: showOutput }">▸</span>
        <span class="toggle-label">
          输出
          <span v-if="parsedResult.status === 'timeout'" class="timeout-badge">超时</span>
          <span v-else-if="parsedResult.status === 'error'" class="error-badge">错误</span>
        </span>
      </button>
      <div v-if="showOutput" class="output-body">
        <pre class="output-pre">{{ truncatedOutput.text }}</pre>
        <div v-if="truncatedOutput.truncated" class="output-truncated">
          显示前 {{ OUTPUT_MAX_LINES }} 行 / 共 {{ truncatedOutput.totalLines }} 行
        </div>
        <div v-if="parsedResult.logPath" class="output-log">日志: {{ parsedResult.logPath }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.cmd-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 80%, transparent);

  &.status-error {
    border-color: color-mix(in srgb, var(--danger) 32%, transparent);
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
}

.cmd-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .cmd-icon {
    font-size: 12px;
  }

  .cmd-name {
    font-weight: 700;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .cmd-status {
    font-weight: 800;
    font-size: 12px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: cmd-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
  }
}

.cmd-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cmd-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.cmd-label {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
}

.cmd-code-wrap {
  position: relative;
  min-width: 0;
}

.cmd-code {
  display: block;
  padding: 2px 18px 2px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.cmd-meta-inline {
  flex: 1;
  min-width: 0;
  text-align: right;
  margin-left: 2px;
  margin-right: 8px;
  font-size: 9.5px;
  font-weight: 500;
  color: color-mix(in srgb, var(--ink) 48%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-desc {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  line-height: 17px;
  color: color-mix(in srgb, var(--ink) 92%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}

.copy-btn {
  position: absolute;
  top: 1px;
  right: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  cursor: pointer;
  user-select: none;

  .el-icon {
    font-size: 10px;
  }

  &:hover {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 84%, transparent);
  }

  &.copied {
    border-color: color-mix(in srgb, var(--success) 40%, transparent);
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: #16a34a;
  }
}

.cmd-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

.toggle {
  display: inline-flex;
  align-items: flex-start;
  gap: 4px;
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  text-align: left;

  &:hover {
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .toggle-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
}

.caret {
  display: inline-block;
  transition: transform 140ms ease;

  &.open {
    transform: rotate(90deg);
  }
}

.timeout-badge,
.error-badge {
  display: inline-block;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
}

.timeout-badge {
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  color: var(--warning);
}

.error-badge {
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  color: var(--danger);
}

.output-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 12px;
}

.output-pre {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  color: color-mix(in srgb, var(--ink) 86%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
}

.output-truncated {
  font-size: 9px;
  font-style: italic;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
}

.output-log {
  font-size: 9.5px;
  color: color-mix(in srgb, var(--ink) 50%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  word-break: break-all;
}

@keyframes cmd-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
