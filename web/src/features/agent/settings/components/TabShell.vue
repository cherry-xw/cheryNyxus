<script setup lang="ts">
/**
 * TabShell：设置面板各 tab 的通用外壳。
 * 顶部固定区：hints slot（sect-hint / warn-hint 说明行）+ 序号按钮行（indexItems 驱动）。
 * 序号按钮：hover 触发自定义 popper（通过 popper scoped slot 由 tab 自填 mini 卡面），点击滚到对应卡片。
 * 下方 scroll-area：默认 slot，放一列卡片（每张卡片加 :data-anchor="item.anchor"）。
 *
 * 约定：
 *  - indexItems[i].anchor 对应 scroll-area 内 data-anchor="<anchor>" 的卡片。
 *  - indexItems 为空时序号行自动隐藏。
 *  - popper slot 接收 { item, index }，由各 tab 定制 mini 卡面内容。
 *  - 超过 20 项时自动启用 IndexPaginator 翻页器。
 */
import { computed, inject, ref } from 'vue'
import IndexPaginator from './IndexPaginator.vue'
import { SETTINGS_ACTIVE_TAB_KEY, type TabKey } from '../constants'

export interface IndexItem {
  /** 卡面标题（必填，popper 内主标题；按钮 aria-label 也用这个） */
  label: string
  /** 滚动锚点（与卡片 data-anchor 匹配），不填默认用 index */
  anchor?: string
  /** tab 自填字段，供 popper slot 渲染 mini 卡面时使用 */
  [key: string]: unknown
}

const props = defineProps<{
  tabKey: TabKey
  indexItems?: IndexItem[]
  page?: number
  pageSize?: number
  total?: number
}>()
const emit = defineEmits<{ (e: 'page-change', page: number): void }>()

const scrollRef = ref<HTMLElement | null>(null)
const activeTab = inject(SETTINGS_ACTIVE_TAB_KEY)
const isActive = computed(() => activeTab?.value === props.tabKey)

function scrollTo(item: IndexItem, i: number): void {
  const anchor = item.anchor ?? String(i)
  const el = scrollRef.value?.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <div class="tab-shell-root">
    <section class="sect shell-sect">
      <div class="shell-sticky">
        <div v-if="$slots.hints" class="shell-hints">
          <slot name="hints" />
        </div>
        <div v-if="$slots.toolbar" class="shell-toolbar">
          <slot name="toolbar" />
        </div>
      </div>
      <div ref="scrollRef" class="shell-scroll">
        <slot />
      </div>
    </section>
    <Teleport defer to="#settings-footer-nav">
      <IndexPaginator
        v-if="isActive && props.indexItems?.length"
        :items="props.indexItems"
        :page="props.page"
        :page-size="props.pageSize"
        :total="props.total"
        @scroll-to="scrollTo"
        @page-change="emit('page-change', $event)"
      >
        <template #popper="scope">
          <slot name="popper" v-bind="scope" />
        </template>
      </IndexPaginator>
    </Teleport>
  </div>
</template>

<style scoped lang="less">
// .shell-* 版式原语已上提 shared.less；本组件只留无 DOM 可挂的 popper 副作用样式。
.tab-shell-root {
  height: 100%;
  min-height: 0;
}
</style>

<!--
  el-popover 内容 teleport 到 body，scoped 样式无法穿透。
  这里用非 scoped 样式定义 mini 卡面基础外观；各 tab 的 popper slot 内复用 .index-card 类即可。
-->
<style lang="less">
@import '../shared.less';

.index-card-popper-wrap {
  // 覆盖 el-popover 默认内边距，让 mini 卡面贴边。
  padding: 0 !important;
}

.index-card {
  // tab 内 popper slot 的统一 mini 卡面基础样式。
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: #fbf9f4;

  .index-card-title {
    font-size: 12px;
    font-weight: 800;
    color: fade(@ink, 88%);
    line-height: 1.3;
    word-break: break-all;
  }

  .index-card-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 11px;
    color: fade(@ink, 70%);
    line-height: 1.4;

    b {
      font-weight: 700;
      color: fade(@ink, 55%);
      font-size: 10px;
      letter-spacing: 0.02em;
      flex: 0 0 auto;
      min-width: 34px;
    }

    span {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: fade(@ink, 82%);
    }
  }

  .index-card-empty {
    font-size: 11px;
    color: fade(@ink, 42%);
    font-style: italic;
  }
}
</style>
