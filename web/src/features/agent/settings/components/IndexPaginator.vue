<script setup lang="ts">
/**
 * IndexPaginator：序号行翻页器。
 * 当 TabShell 的 indexItems 超过阈值时替代 flat 序号行，
 * 提供单行展示 + 左右翻页 + 页码指示。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch } from "vue";
import { ArrowLeft, ArrowRight } from "@element-plus/icons-vue";
import type { IndexItem } from "./TabShell.vue";

const PILL_WIDTH = 19; // 16px min-width + 3px gap
const THRESHOLD = 20;

const props = defineProps<{
  items: IndexItem[];
  activeAnchor?: string;
  page?: number;
  pageSize?: number;
  total?: number;
}>();

const emit = defineEmits<{
  (e: "scroll-to", item: IndexItem, index: number): void;
  (e: "page-change", page: number): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const windowStart = ref(0);

const visibleCount = computed(() => {
  if (!containerRef.value) return THRESHOLD;
  const available = containerRef.value.clientWidth;
  // 留出左右箭头 + 页码指示的空间
  const reserved = 60; // 2 arrows + page info
  return Math.max(5, Math.floor((available - reserved) / PILL_WIDTH));
});

const needPagination = computed(() => props.items.length > THRESHOLD);
const remoteMode = computed(() => props.page !== undefined && props.pageSize !== undefined && props.total !== undefined);
const remotePageCount = computed(() => Math.max(1, Math.ceil((props.total ?? 0) / (props.pageSize ?? 1))));
const remotePage = computed(() => props.page ?? 1);
const remotePageSize = computed(() => props.pageSize ?? 1);
const remoteTotal = computed(() => props.total ?? 0);
const remotePages = computed(() => {
  const current = props.page ?? 1;
  const start = Math.max(1, Math.min(remotePageCount.value - 6, current - 3));
  return Array.from({ length: Math.min(7, remotePageCount.value) }, (_, index) => start + index);
});

const windowEnd = computed(() =>
  Math.min(windowStart.value + visibleCount.value, props.items.length),
);

const visibleItems = computed(() =>
  props.items.slice(windowStart.value, windowEnd.value),
);

const canGoLeft = computed(() => windowStart.value > 0);
const canGoRight = computed(() => windowEnd.value < props.items.length);

function shiftLeft(): void {
  windowStart.value = Math.max(0, windowStart.value - visibleCount.value);
}
function shiftRight(): void {
  windowStart.value = Math.min(
    props.items.length - visibleCount.value,
    windowStart.value + visibleCount.value,
  );
}

function scrollTo(item: IndexItem, i: number): void {
  // 自动平移窗口使目标居中
  const globalIndex = windowStart.value + i;
  const half = Math.floor(visibleCount.value / 2);
  const newStart = Math.max(0, Math.min(props.items.length - visibleCount.value, globalIndex - half));
  windowStart.value = newStart;
  emit("scroll-to", item, globalIndex);
}

// 当 items 变化时重置窗口
watch(() => props.items.length, () => {
  windowStart.value = 0;
});

// ResizeObserver
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  if (!containerRef.value) return;
  resizeObserver = new ResizeObserver(() => {
    // visibleCount 是 computed，自动重算
  });
  resizeObserver.observe(containerRef.value);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
});
</script>

<template>
  <div v-if="remoteMode" class="shell-index-row paginated remote-pager">
    <button type="button" class="shell-index-nav" :disabled="remotePage <= 1" aria-label="上一页" @click="emit('page-change', remotePage - 1)"><ArrowLeft class="ico" /></button>
    <button v-for="p in remotePages" :key="p" type="button" class="shell-index-btn" :class="{ active: p === page }" :aria-label="`第 ${p} 页`" @click="emit('page-change', p)">{{ p }}</button>
    <span class="shell-index-page-info">{{ ((remotePage - 1) * remotePageSize) + 1 }}-{{ Math.min(remotePage * remotePageSize, remoteTotal) }} / {{ remoteTotal }}</span>
    <button type="button" class="shell-index-nav" :disabled="remotePage >= remotePageCount" aria-label="下一页" @click="emit('page-change', remotePage + 1)"><ArrowRight class="ico" /></button>
  </div>
  <div v-else-if="needPagination" ref="containerRef" class="shell-index-row paginated">
    <button
      type="button"
      class="shell-index-nav"
      :disabled="!canGoLeft"
      aria-label="上一页"
      @click="shiftLeft"
    >
      <ArrowLeft class="ico" />
    </button>
    <el-popover
      v-for="(item, i) in visibleItems"
      :key="item.anchor ?? windowStart + i"
      trigger="hover"
      placement="bottom"
      :width="228"
      popper-class="index-card-popper-wrap"
      :offset="4"
    >
      <template #default>
        <slot name="popper" :item="item" :index="windowStart + i" />
      </template>
      <template #reference>
        <button
          type="button"
          class="shell-index-btn"
          :aria-label="`跳到第 ${windowStart + i + 1} 项：${item.label}`"
          @click="scrollTo(item, i)"
        >{{ windowStart + i + 1 }}</button>
      </template>
    </el-popover>
    <span class="shell-index-page-info">{{ windowStart + 1 }}-{{ windowEnd }} / {{ items.length }}</span>
    <button
      type="button"
      class="shell-index-nav"
      :disabled="!canGoRight"
      aria-label="下一页"
      @click="shiftRight"
    >
      <ArrowRight class="ico" />
    </button>
  </div>
  <!-- 少量项时直接渲染 flat 行（无翻页） -->
  <div v-else class="shell-index-row">
    <el-popover
      v-for="(item, i) in items"
      :key="item.anchor ?? i"
      trigger="hover"
      placement="bottom"
      :width="228"
      popper-class="index-card-popper-wrap"
      :offset="4"
    >
      <template #default>
        <slot name="popper" :item="item" :index="i" />
      </template>
      <template #reference>
        <button
          type="button"
          class="shell-index-btn"
          :aria-label="`跳到第 ${i + 1} 项：${item.label}`"
          @click="emit('scroll-to', item, i)"
        >{{ i + 1 }}</button>
      </template>
    </el-popover>
  </div>
</template>

<style scoped lang="less">
@import "../shared.less";

.shell-index-row {
  display: flex;
  gap: 3px;
  align-items: center;
  &.paginated {
    flex-wrap: nowrap;
    overflow: hidden;
  }
}
.shell-index-btn.active {
  background: color-mix(in srgb, var(--tab-color, @accent) 18%, transparent);
  border-color: color-mix(in srgb, var(--tab-color, @accent) 55%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tab-color, @accent) 30%, transparent);
}
.ico {
  width: 10px;
  height: 10px;
}
</style>
