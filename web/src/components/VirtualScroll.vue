<script setup lang="ts" generic="T">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";

type ItemKey = string | number;
type ScrollAlign = "start" | "center" | "end";

const DEFAULT_ESTIMATED_SIZE = 120;
const OVERSCAN_PX = 600;

const props = withDefaults(
  defineProps<{
    /** 要虚拟化渲染的数据。 */
    items: readonly T[];
    /** 项的稳定唯一标识。高度缓存以此为索引，离屏后仍会保留。 */
    itemKey: (item: T, index: number) => ItemKey;
    /** 尚未量测时的单项高度估算。 */
    estimateSize?: (item: T, index: number) => number;
    /** 可视范围不足时最少渲染的条数。 */
    defaultRenderCount?: number;
  }>(),
  {
    estimateSize: () => DEFAULT_ESTIMATED_SIZE,
    defaultRenderCount: 12,
  },
);

const containerRef = ref<HTMLElement | null>(null);
const viewportHeight = ref(0);
const scrollTop = ref(0);
const measuredSizes = reactive(new Map<ItemKey, number>());
const itemObservers = new Map<ItemKey, { element: HTMLElement; observer?: ResizeObserver }>();
const pendingMeasurements = new Map<ItemKey, HTMLElement>();
let scrollRafId = 0;
let measureRafId = 0;
let containerResizeObserver: ResizeObserver | undefined;

const itemKeys = computed<ItemKey[]>(() => props.items.map((item, index) => props.itemKey(item, index)));
const indexByKey = computed(() => new Map(itemKeys.value.map((key, index) => [key, index])));

function getItemSize(index: number): number {
  const key = itemKeys.value[index]!;
  const measuredSize = measuredSizes.get(key);
  return measuredSize ?? props.estimateSize(props.items[index]!, index);
}

const offsets = computed<number[]>(() => {
  const values = new Array<number>(props.items.length + 1);
  values[0] = 0;
  for (let index = 0; index < props.items.length; index += 1) {
    values[index + 1] = values[index]! + getItemSize(index);
  }
  return values;
});

const totalSize = computed(() => offsets.value[props.items.length] ?? 0);

function findFirstVisibleIndex(offset: number): number {
  let low = 0;
  let high = props.items.length;
  const values = offsets.value;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle + 1]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function findEndExclusive(offset: number): number {
  let low = 0;
  let high = props.items.length;
  const values = offsets.value;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

const renderedIndices = computed<number[]>(() => {
  const itemCount = props.items.length;
  if (itemCount === 0) return [];

  const start = findFirstVisibleIndex(Math.max(0, scrollTop.value - OVERSCAN_PX));
  const visibleEnd = findEndExclusive(scrollTop.value + viewportHeight.value + OVERSCAN_PX);
  const minEnd = start + Math.max(1, Math.floor(props.defaultRenderCount));
  const endExclusive = Math.min(itemCount, Math.max(visibleEnd, minEnd));

  return Array.from({ length: endExclusive - start }, (_, offset) => start + offset);
});

function syncScrollTop(): void {
  const element = containerRef.value;
  if (element && scrollTop.value !== element.scrollTop) scrollTop.value = element.scrollTop;
}

function onScroll(): void {
  if (scrollRafId !== 0) return;
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = 0;
    syncScrollTop();
  });
}

function flushMeasurements(): void {
  measureRafId = 0;
  const element = containerRef.value;
  const previousOffsets = offsets.value;
  const currentScrollTop = element?.scrollTop ?? scrollTop.value;
  let anchorAdjustment = 0;

  pendingMeasurements.forEach((itemElement, key) => {
    if (!itemElement.isConnected) return;
    const index = indexByKey.value.get(key);
    if (index === undefined) return;

    const nextSize = itemElement.getBoundingClientRect().height;
    const previousSize = getItemSize(index);
    if (Math.abs(nextSize - previousSize) <= 0.5) return;

    // 仅补偿完整位于视口上方的项；视口中的内容尺寸变化应自然呈现。
    if (previousOffsets[index + 1]! <= currentScrollTop + 0.5) {
      anchorAdjustment += nextSize - previousSize;
    }
    measuredSizes.set(key, nextSize);
  });
  pendingMeasurements.clear();

  if (element && anchorAdjustment !== 0) {
    element.scrollTop = Math.max(0, currentScrollTop + anchorAdjustment);
    syncScrollTop();
  }
}

function scheduleMeasurement(key: ItemKey, element: HTMLElement): void {
  pendingMeasurements.set(key, element);
  if (measureRafId !== 0) return;
  measureRafId = requestAnimationFrame(flushMeasurements);
}

function registerItem(key: ItemKey, element: Element | ComponentPublicInstance | null): void {
  const previous = itemObservers.get(key);
  if (!element) {
    previous?.observer?.disconnect();
    itemObservers.delete(key);
    pendingMeasurements.delete(key);
    return;
  }

  if (!(element instanceof HTMLElement)) return;
  const htmlElement = element;
  if (previous?.element === htmlElement) return;

  previous?.observer?.disconnect();
  const observer = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(() => scheduleMeasurement(key, htmlElement));
  observer?.observe(htmlElement);
  itemObservers.set(key, { element: htmlElement, observer });
  scheduleMeasurement(key, htmlElement);
}

function scrollToIndex(
  index: number,
  options: { align?: ScrollAlign; behavior?: ScrollBehavior } = {},
): void {
  void nextTick(() => {
    const element = containerRef.value;
    if (!element || index < 0 || index >= props.items.length) return;

    const align = options.align ?? "start";
    const itemTop = offsets.value[index]!;
    const itemSize = offsets.value[index + 1]! - itemTop;
    let target = itemTop;
    if (align === "center") target = itemTop - element.clientHeight / 2 + itemSize / 2;
    if (align === "end") target = itemTop - element.clientHeight + itemSize;

    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTo({
      top: Math.min(Math.max(0, target), maxScrollTop),
      behavior: options.behavior ?? "auto",
    });
  });
}

function scrollToEnd(): void {
  void nextTick(() => {
    const element = containerRef.value;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    syncScrollTop();
  });
}

watch(itemKeys, (keys) => {
  const validKeys = new Set(keys);
  measuredSizes.forEach((_, key) => {
    if (!validKeys.has(key)) measuredSizes.delete(key);
  });
});

onMounted(() => {
  const element = containerRef.value;
  if (!element) return;
  viewportHeight.value = element.clientHeight;
  if (typeof ResizeObserver === "undefined") return;
  containerResizeObserver = new ResizeObserver(([entry]) => {
    const height = entry?.contentRect.height ?? 0;
    if (height > 0 && viewportHeight.value !== Math.floor(height)) {
      viewportHeight.value = Math.floor(height);
    }
  });
  containerResizeObserver.observe(element);
});

onBeforeUnmount(() => {
  if (scrollRafId) cancelAnimationFrame(scrollRafId);
  if (measureRafId) cancelAnimationFrame(measureRafId);
  containerResizeObserver?.disconnect();
  itemObservers.forEach(({ observer }) => observer?.disconnect());
  itemObservers.clear();
  pendingMeasurements.clear();
});

defineExpose({ scrollToEnd, scrollToIndex });
</script>

<template>
  <div ref="containerRef" class="virtual-scroll" @scroll.passive="onScroll">
    <div class="virtual-scroll-content" :style="{ height: `${totalSize}px` }">
      <div
        v-for="index in renderedIndices"
        :key="itemKeys[index]!"
        :ref="(element) => registerItem(itemKeys[index]!, element)"
        class="virtual-scroll-item"
        :style="{ transform: `translate3d(0, ${offsets[index]}px, 0)` }"
      >
        <slot :item="items[index]" :index="index" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.virtual-scroll {
  position: relative;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overflow-anchor: none;
}

.virtual-scroll-content {
  position: relative;
  width: 100%;
}

.virtual-scroll-item {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  box-sizing: border-box;
  padding-bottom: var(--virtual-scroll-gap, 0px);
  will-change: transform;
}
</style>
