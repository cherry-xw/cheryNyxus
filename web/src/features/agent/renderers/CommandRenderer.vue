<script setup lang="ts">
/**
 * CommandRenderer：execute_command 专用渲染器。
 *
 * UI 设计：
 * - 头部：💻 图标 + "执行命令" + 状态指示
 * - 命令行：<code> 样式显示完整命令
 * - 输出区（可折叠，默认收起）：
 *   - 成功：显示 stdout/stderr（截断到 500 行）
 *   - 错误：红色高亮 error 信息
 *   - 超时：显示 timeout 提示 + logPath
 * - 元信息：duration（毫秒）+ pid + exitCode
 */
import { computed, onBeforeUnmount, ref } from "vue";
import type { RendererProps, ExecuteCommandArgs, ExecuteCommandResult } from "./types";

const props = defineProps<RendererProps>();

const showOutput = ref(false);

// 解析参数
const parsedArgs = computed<ExecuteCommandArgs | null>(() => {
  try {
    const raw = typeof props.call.args === "string" ? props.call.args : JSON.stringify(props.call.args ?? {});
    const obj = JSON.parse(raw) as ExecuteCommandArgs;
    if (obj.command) return obj;
    return null;
  } catch (e) {
    console.warn("[CommandRenderer] args 解析失败", e);
    return null;
  }
});

// 解析结果（后端返回字符串格式）
const parsedResult = computed<ExecuteCommandResult | null>(() => {
  if (!props.call.result || typeof props.call.result !== "string") return null;
  try {
    const text = props.call.result as string;

    // 正则提取字段（key 与后端 bash.ts formatBashResult 中文文案严格一致，见 docs/web/renderer.md）
    const statusMatch = text.match(/状态:\s*(\w+)/);
    const pidMatch = text.match(/进程ID:\s*(\d+)/);
    const exitCodeMatch = text.match(/退出码:\s*(\d+)/);
    const durationMatch = text.match(/执行时长:\s*(\d+)ms/);
    const outputMatch = text.match(/\[输出\]\r?\n([\s\S]*)/);
    const logPathMatch = text.match(/日志路径:\s*([^\n]+)/);
    const messageMatch = text.match(/说明:\s*([^\n]+)/);

    return {
      status: (statusMatch?.[1] ?? "error") as ExecuteCommandResult["status"],
      pid: pidMatch?.[1] ? parseInt(pidMatch[1], 10) : 0,
      exitCode: exitCodeMatch?.[1] ? parseInt(exitCodeMatch[1], 10) : undefined,
      duration: durationMatch?.[1] ? parseInt(durationMatch[1], 10) : 0,
      // 后端 result 不输出 command/description，从 args 取（fallback 降级 JSON）
      command: parsedArgs.value?.command ?? "",
      description: parsedArgs.value?.description ?? "",
      output: outputMatch?.[1] ?? "",
      // 日志路径行尾带「（详细信息使用 read_file 读取）」说明，剔除之
      logPath: logPathMatch?.[1]?.split("（")[0]?.trim(),
      message: messageMatch?.[1]?.trim(),
    };
  } catch (e) {
    console.warn("[CommandRenderer] result 解析失败", e);
    return null;
  }
});

// 输出截断（最多 500 行）
const OUTPUT_MAX_LINES = 500;
const truncatedOutput = computed(() => {
  const output = parsedResult.value?.output ?? "";
  const lines = output.split("\n");
  if (lines.length <= OUTPUT_MAX_LINES) {
    return { text: output, truncated: false, totalLines: lines.length };
  }
  return {
    text: lines.slice(0, OUTPUT_MAX_LINES).join("\n"),
    truncated: true,
    totalLines: lines.length,
  };
});

// 状态字形和样式
const statusGlyph = computed(() => {
  switch (props.call.status) {
    case "running":
      return "⋯";
    case "done":
      return parsedResult.value?.status === "error" ? "✗" : "✓";
    case "error":
      return "✗";
    default:
      return "?";
  }
});

const statusClass = computed(() => {
  if (props.call.status === "error" || parsedResult.value?.status === "error") {
    return "status-error";
  }
  if (props.call.status === "running") {
    return "status-running";
  }
  return "status-done";
});

// 降级显示
const fallback = computed(() => {
  if (!parsedArgs.value) {
    return JSON.stringify(props.call.args ?? {}, null, 2);
  }
  return "";
});

// 复制命令到剪贴板（仅 command 文本）；成功后瞬时反馈 1.2s
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copyCommand(): Promise<void> {
  const cmd = parsedArgs.value?.command ?? "";
  if (!cmd) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(cmd);
    } else {
      // 降级：execCommand（兼容非 HTTPS / 旧 Electron webview）
      const ta = document.createElement("textarea");
      ta.value = cmd;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch (e) {
    console.warn("[CommandRenderer] 复制失败", e);
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <div class="cmd-box" :class="statusClass">
    <div class="cmd-head">
      <span class="cmd-icon" aria-hidden="true">💻</span>
      <span class="cmd-name">执行命令</span>
      <span class="cmd-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 命令行 -->
    <div v-if="parsedArgs" class="cmd-section">
      <div class="cmd-row">
        <span class="cmd-label">命令:</span>
        <code class="cmd-code">{{ parsedArgs.command }}</code>
        <button
          type="button"
          class="copy-btn"
          :class="{ copied: copied }"
          :aria-label="copied ? '已复制' : '复制命令'"
          @click="copyCommand"
        >
          {{ copied ? "✓ 已复制" : "📋 复制" }}
        </button>
      </div>
      <div v-if="parsedArgs.description" class="cmd-row">
        <span class="cmd-label">说明:</span>
        <span class="cmd-desc">{{ parsedArgs.description }}</span>
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
      </div>

      <!-- 元信息 -->
      <div class="cmd-meta">
        <span v-if="parsedResult.duration" class="meta-item">
          耗时: {{ parsedResult.duration }}ms
        </span>
        <span v-if="parsedResult.pid" class="meta-item">
          PID: {{ parsedResult.pid }}
        </span>
        <span v-if="parsedResult.exitCode !== undefined" class="meta-item">
          退出码: {{ parsedResult.exitCode }}
        </span>
        <span v-if="parsedResult.logPath" class="meta-item">
          日志: {{ parsedResult.logPath }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.cmd-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  color: fade(@ink, 80%);

  &.status-error {
    border-color: rgba(220, 38, 38, 0.32);
    background: rgba(254, 242, 242, 0.66);
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
    flex: 1;
    font-weight: 700;
    color: fade(@ink, 86%);
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
  color: fade(@ink, 56%);
}

.cmd-code {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  color: fade(@ink, 88%);
}

.cmd-desc {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: fade(@ink, 70%);
}

.copy-btn {
  flex-shrink: 0;
  align-self: center;
  padding: 1px 6px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.7);
  color: fade(@ink, 60%);
  font-size: 9.5px;
  font-family: inherit;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;

  &:hover {
    background: #ffffff;
    color: fade(@ink, 84%);
  }

  &.copied {
    border-color: rgba(22, 163, 74, 0.4);
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
  }
}

.cmd-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: rgba(20, 22, 26, 0.06);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
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
  color: fade(@ink, 64%);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  user-select: none;
  text-align: left;

  &:hover {
    color: fade(@ink, 86%);
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
  background: rgba(234, 179, 8, 0.16);
  color: #ca8a04;
}

.error-badge {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
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
  background: rgba(20, 22, 26, 0.06);
  color: fade(@ink, 86%);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
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
  color: fade(@ink, 50%);
}

.cmd-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 12px;
  margin-top: 2px;
}

.meta-item {
  font-size: 9.5px;
  color: fade(@ink, 56%);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
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