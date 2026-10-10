<script setup lang="ts">
defineProps<{ maxControlState: string }>()
const emit = defineEmits<{ minimize: []; maximize: []; close: [] }>()
</script>

<template>
  <div class="workbench-window-actions" role="group" aria-label="窗口控制">
    <button
      type="button"
      class="window-control is-minimize"
      aria-label="最小化工作台"
      title="最小化"
      @click="emit('minimize')"
    >
      <span class="window-control-icon is-minimize" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="window-control is-maximize"
      :aria-label="maxControlState === 'restore' ? '还原窗口' : '最大化窗口'"
      :title="maxControlState === 'restore' ? '还原' : '最大化'"
      @click="emit('maximize')"
    >
      <span
        class="window-control-icon"
        :class="maxControlState === 'restore' ? 'is-restore' : 'is-maximize'"
        aria-hidden="true"
      />
    </button>
    <button
      type="button"
      class="window-control is-close"
      aria-label="关闭节点树工作台"
      title="关闭"
      @click="emit('close')"
    >
      <span class="window-control-icon is-close" aria-hidden="true" />
    </button>
  </div>
</template>
