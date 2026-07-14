<script setup lang="ts">
/**
 * SearchRenderer：search_codebase 专用渲染器。
 *
 * UI 设计：
 * - 头部：🔍 图标 + "搜索代码库" + 模式标签
 * - 搜索参数：
 *   - content 模式：query + regex? + contextLines?
 *   - filename 模式：query（文件名匹配）
 * - 结果列表（可折叠，默认展开）：
 *   - 文件路径 + 行号（可点击跳转）
 *   - 匹配内容高亮
 */
import { computed, ref } from "vue";
import type { RendererProps, SearchCodebaseArgs } from "./types";

const props = defineProps<RendererProps>();

const showResults = ref(true);

// 解析参数
const parsedArgs = computed<SearchCodebaseArgs | null>(() => {
  try {
    const raw = typeof props.call.args === "string" ? props.call.args : JSON.stringify(props.call.args ?? {});
    const obj = JSON.parse(raw) as SearchCodebaseArgs;
    if (obj.path && obj.query) return obj;
    return null;
  } catch (e) {
    console.warn("[SearchRenderer] args 解析失败", e);
    return null;
  }
});

// 模式标签
const modeLabel = computed(() => {
  return parsedArgs.value?.mode === "filename" ? "文件名" : "内容";
});

// 解析结果（按换行分割，提取文件路径 + 行号）
interface SearchResult {
  filePath: string;
  line?: number;
  content?: string;
}

const searchResults = computed<SearchResult[]>(() => {
  if (!props.call.result || typeof props.call.result !== "string") return [];
  const text = props.call.result as string;

  // 按换行分割
  const lines = text.split("\n").filter((line) => line.trim());

  // 匹配文件路径:行号 格式
  const results: SearchResult[] = [];
  for (const line of lines) {
    const match = line.match(/^([^\s:]+):(\d+):(.*)$/);
    if (match && match[1] && match[2]) {
      results.push({
        filePath: match[1],
        line: parseInt(match[2], 10),
        content: match[3]?.trim() ?? "",
      });
    } else {
      // 文件名模式（无行号）
      const fileNameMatch = line.match(/^([^\s:]+)$/);
      if (fileNameMatch && fileNameMatch[1]) {
        results.push({
          filePath: fileNameMatch[1],
        });
      }
    }
  }

  return results;
});

// 结果数量
const resultCount = computed(() => searchResults.value.length);

// 状态字形和样式
const statusGlyph = computed(() => {
  switch (props.call.status) {
    case "running":
      return "⋯";
    case "done":
      return "✓";
    case "error":
      return "✗";
    default:
      return "?";
  }
});

const statusClass = computed(() => `status-${props.call.status}`);

// 降级显示
const fallback = computed(() => {
  if (!parsedArgs.value) {
    return JSON.stringify(props.call.args ?? {}, null, 2);
  }
  return "";
});
</script>

<template>
  <div class="search-box" :class="statusClass">
    <div class="search-head">
      <span class="search-icon" aria-hidden="true">🔍</span>
      <span class="search-name">搜索代码库</span>
      <span class="search-mode">{{ modeLabel }}</span>
      <span class="search-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 搜索参数 -->
    <div v-if="parsedArgs" class="search-section">
      <div class="search-row">
        <span class="search-label">查询:</span>
        <code class="search-query">{{ parsedArgs.query }}</code>
      </div>
      <div v-if="parsedArgs.regex" class="search-row">
        <span class="search-label">模式:</span>
        <span class="search-badge">正则</span>
      </div>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="search-fallback">{{ fallback }}</pre>

    <!-- 结果列表 -->
    <div v-if="searchResults.length > 0" class="search-section">
      <button
        type="button"
        class="toggle"
        :aria-expanded="showResults"
        @click="showResults = !showResults"
      >
        <span class="caret" :class="{ open: showResults }">▸</span>
        <span class="toggle-label">
          结果
          <span class="result-count">{{ resultCount }} 项</span>
        </span>
      </button>
      <div v-if="showResults" class="results-body">
        <div v-for="(result, idx) in searchResults" :key="idx" class="result-item">
          <span class="result-file">{{ result.filePath }}</span>
          <span v-if="result.line" class="result-line">:{{ result.line }}</span>
          <span v-if="result.content" class="result-content">{{ result.content }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.search-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.66);
  font-size: 11px;
  color: fade(@ink, 80%);
}

.search-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .search-icon {
    font-size: 12px;
  }

  .search-name {
    flex: 1;
    font-weight: 700;
    color: fade(@ink, 86%);
  }

  .search-mode {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(59, 130, 246, 0.12);
    color: #2563eb;
    font-weight: 700;
  }

  .search-status {
    font-weight: 800;
    font-size: 12px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: search-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
  }
}

.search-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.search-label {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: fade(@ink, 56%);
}

.search-query {
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

.search-badge {
  display: inline-block;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  background: rgba(168, 85, 247, 0.12);
  color: #9333ea;
}

.search-fallback {
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
    gap: 6px;
  }
}

.caret {
  display: inline-block;
  transition: transform 140ms ease;

  &.open {
    transform: rotate(90deg);
  }
}

.result-count {
  font-size: 9px;
  color: fade(@ink, 50%);
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
}

.results-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 12px;
  max-height: 200px;
  overflow: auto;
}

.result-item {
  display: flex;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
  padding: 2px 0;
}

.result-file {
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10px;
  color: #2563eb;
  font-weight: 600;
  word-break: break-all;
}

.result-line {
  font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 10px;
  color: fade(@ink, 56%);
  flex-shrink: 0;
}

.result-content {
  flex: 1;
  min-width: 0;
  margin-left: 6px;
  font-size: 10px;
  color: fade(@ink, 70%);
  white-space: pre-wrap;
  word-break: break-word;
}

@keyframes search-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>