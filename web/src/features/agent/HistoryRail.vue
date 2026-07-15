<script setup lang="ts">
/**
 * HistoryRail：历史抽屉左侧外快捷跳转栏。
 *
 * 三段（顶/中/底）：
 * - 顶部按钮 → emit jumpTop（父组件滚到对话最顶）；用 EP ArrowUp 线框 icon
 * - 中间用户消息簇 → 每条 role === "user" 一个 mark，emit jump(idx)
 * - 底部按钮 → emit jumpBottom；用 EP ArrowDown 线框 icon
 *
 * 视觉：去掉之前的深色 pill（用户反馈"突兀"），改透明 + 自带对比。
 * 中间 marks 增大点击面积（padding 6px 上下 → 16px 总高），整体上下居中聚拢。
 *
 * 不引入 store / RPC / 虚拟列表——纯展示组件，副作用由父组件 HistoryDrawerPanel 处理。
 */
import type { HistoryItem } from "@/stores/agents";
import { ArrowUp, ArrowDown } from "@element-plus/icons-vue";

defineProps<{
  /** 用户消息列表（父 computed 已过滤 role === "user"，这里仅透传 idx 用于跳索引）。 */
  marks: ReadonlyArray<{ item: HistoryItem; idx: number }>;
}>();

defineEmits<{
  (e: "jump", idx: number): void;
  (e: "jumpTop"): void;
  (e: "jumpBottom"): void;
}>();

/** 取前 N 字预览：折叠空白字符 + 去首尾空白 + 超长加 ellipsis。空内容显占位串。 */
function previewOf(content: string | undefined): string {
  if (!content) return "(空)";
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 10 ? compact.slice(0, 10) + "…" : compact;
}
</script>

<template>
  <nav class="history-rail" aria-label="历史消息快速跳转">
    <el-tooltip content="滚动到顶部" placement="left" :show-after="120">
      <button
        type="button"
        class="rail-edge rail-top"
        aria-label="滚动到顶部"
        @click="$emit('jumpTop')"
      >
        <ArrowUp />
      </button>
    </el-tooltip>

    <div v-if="marks.length > 0" class="rail-cluster">
      <el-tooltip
        v-for="m in marks"
        :key="m.item.msgId ?? `idx-${m.idx}`"
        :content="previewOf(m.item.content)"
        placement="left"
        :show-after="120"
      >
        <button
          type="button"
          class="rail-mark"
          :aria-label="`跳转到用户消息: ${previewOf(m.item.content)}`"
          @click="$emit('jump', m.idx)"
        />
      </el-tooltip>
    </div>

    <el-tooltip content="滚动到底部" placement="left" :show-after="120">
      <button
        type="button"
        class="rail-edge rail-bottom"
        aria-label="滚动到底部"
        @click="$emit('jumpBottom')"
      >
        <ArrowDown />
      </button>
    </el-tooltip>
  </nav>
</template>

<style scoped lang="less">
// 容器透明：marks 与 icons 自带对比，不靠深色背景撞视觉
.history-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  padding: 8px 0;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}
// 上下外边距 auto：内容少时整组停在视觉中央；内容过长时 auto 收缩 → 自然滚动
.history-rail > :first-child { margin-top: auto; }
.history-rail > :last-child { margin-bottom: auto; }
.rail-cluster {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
// 顶/底：无边框 EP icon 按钮（透明背景 + 白色图标；hover 转主题橙）
.rail-edge {
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 0;
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
  transition: background 0.12s ease, color 0.12s ease;
}
.rail-edge:hover,
.rail-edge:focus-visible {
  background: rgba(246, 183, 60, 0.18);
  color: #ffd27a;
  outline: none;
}
// 中间：默认主题橙细线（::after 2px 高，居中）；hover 颜色加深，尺寸不变（去掉横向 scale 避免"变粗"错觉）。
.rail-mark {
  width: 18px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  display: block;
  position: relative;
  flex-shrink: 0;
}
.rail-mark::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  margin-top: -1px;
  background: #f6b73c;
  border-radius: 1px;
  transition: background 0.12s ease, box-shadow 0.12s ease;
}
.rail-mark:hover::after,
.rail-mark:focus-visible::after {
  background: #92590a;                                       // warning 同系、加深版主题橙
  box-shadow: 0 0 4px rgba(146, 89, 10, 0.55);
}
</style>
