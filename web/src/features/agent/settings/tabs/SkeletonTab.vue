<script setup lang="ts">
/**
 * SkeletonTab：tab-body 加载占位。
 *
 * .shell-hints 内部用真实的 <p class="sect-hint"> / <p class="warn-hint">
 * 元素（带 .skel-shimmer 修饰），由 shared.less 把它们改成 shimmer 色块。
 * 这样：
 *  - 行高、padding、font-size 全部继承真实 hint 样式，
 *  - 计算高度与真实 tab 像素级一致，
 *  - 加载前后 .shell-sticky 整体高度无差，首张可视卡 y 不动；导航占位 Teleport 到 footer。
 *
 * sect / warn 行数由调用方按当前 tab 真值传入（参考 constants.HINT_LINES）。
 */
withDefaults(
  defineProps<{
    /** .sect-hint 段落数（每段 17px 行高，无 padding） */
    sectHints?: number
    /** .warn-hint 段落数（每段 25.4px 含 5px×2 padding） */
    warnHints?: number
    /** footer 左侧序号导航占位数（默认 1） */
    indexCount?: number
  }>(),
  { sectHints: 1, warnHints: 0, indexCount: 1 },
)
</script>

<template>
  <section class="sect shell-sect">
    <div class="shell-sticky">
      <div class="shell-hints">
        <p
          v-for="n in sectHints"
          :key="`sec${n}`"
          class="sect-hint skel-shimmer"
          aria-hidden="true"
        />
        <p
          v-for="n in warnHints"
          :key="`wn${n}`"
          class="warn-hint skel-shimmer"
          aria-hidden="true"
        />
      </div>
    </div>
    <div class="shell-scroll">
      <article v-for="n in 3" :key="n" class="card">
        <span class="card-idx">{{ n }}</span>
        <header class="card-head">
          <span class="card-title">
            <span class="skel-line skel-line-title" />
          </span>
          <span class="card-actions">
            <span class="skel-tile skel-btn-sq" />
          </span>
        </header>
        <div class="field">
          <span class="skel-line" style="width: 28%" />
          <span class="skel-line" style="width: 100%" />
        </div>
        <div class="field">
          <span class="skel-line" style="width: 24%" />
          <span class="skel-line" style="width: 88%" />
        </div>
        <div class="field">
          <span class="skel-line" style="width: 20%" />
          <span class="skel-line" style="width: 100%" />
          <span class="skel-line" style="width: 60%" />
        </div>
      </article>
    </div>
  </section>
  <Teleport defer to="#settings-footer-nav">
    <div class="shell-index-row" aria-hidden="true">
      <span v-for="n in indexCount" :key="n" class="skel-dot" />
    </div>
  </Teleport>
</template>

<style lang="less">
@import '../config/shared.less';
</style>
