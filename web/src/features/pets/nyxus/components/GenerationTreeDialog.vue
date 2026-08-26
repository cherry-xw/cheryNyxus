<script setup lang="ts">
/**
 * GenerationTreeDialog：打包代际二层弹窗（嵌套深度恒 1）。
 *
 * 点击树中 pack 节点打开：经 chats store loadGeneration 拉取该代完整 nodes/edges
 * （LRU 缓存），构造静态 snapshot 传给 MessageBranchTree 复用整条图渲染管线。
 * staticView 挂断 live 投影（输入/流式/CRT），二层内再无 pack 节点（generations 空）。
 */
import { computed, ref, watch } from 'vue'
import { useNyxusHost } from '../application/host'
import type { RootTimelineSnapshot } from '@/application/backend/public'
import type { GenerationPayload } from '@/application/chat/public'
import MessageBranchTree from './MessageBranchTree.vue'

const props = defineProps<{
  rootChatId: string
  /** 1-based，指向 GenerationEntry.index */
  generationIndex: number
}>()
const emit = defineEmits<{ close: [] }>()

const { chats: chatSessions } = useNyxusHost()
const payload = ref<GenerationPayload>()
const loading = ref(false)
const loadError = ref('')

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    payload.value = await chatSessions.loadGeneration(props.rootChatId, props.generationIndex)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '代际历史加载失败'
  } finally {
    loading.value = false
  }
}
watch(() => [props.rootChatId, props.generationIndex], load, { immediate: true })

const titleText = computed(() => {
  const trigger = payload.value?.generation.trigger === 'auto' ? '自动压缩' : '手动压缩'
  const count = payload.value?.generation.nodeCount
  return `打包历史 · 第 ${props.generationIndex} 代 · ${trigger}${count ? ` · ${count} 节点` : ''}`
})

const timelineOverride = computed<RootTimelineSnapshot | undefined>(() => {
  const data = payload.value
  if (!data) return undefined
  return {
    rootChatId: props.rootChatId,
    view: 'tree',
    revision: 0,
    nodes: data.nodes,
    edges: data.edges,
    activeRuns: [],
    pendingInputs: [],
    generations: [],
    capturedEventSeq: 0,
  }
})
</script>

<template>
  <el-dialog
    :model-value="true"
    :title="titleText"
    width="min(920px, 92vw)"
    class="generation-tree-dialog"
    append-to-body
    @update:model-value="emit('close')"
  >
    <div class="generation-tree-body">
      <div v-if="loading" class="generation-tree-status">载入代际历史…</div>
      <div v-else-if="loadError" class="generation-tree-status is-error" role="alert">
        {{ loadError }}
      </div>
      <MessageBranchTree
        v-else-if="timelineOverride"
        :root-chat-id="rootChatId"
        :timeline-override="timelineOverride"
        static-view
      />
    </div>
  </el-dialog>
</template>

<style lang="less">
// 非 scoped：el-dialog 渲染到 body 外层，圆角收敛 ≤6px（项目约定）。
.generation-tree-dialog {
  .el-dialog {
    border-radius: 6px;
  }

  .el-dialog__body {
    padding: 0;
  }
}

.generation-tree-body {
  position: relative; // MessageBranchTree .execution-tree 绝对定位的参照
  height: min(68vh, 720px);
  overflow: hidden;
}

.generation-tree-status {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: color-mix(in srgb, var(--ink, #888) 60%, transparent);
  font-size: 12px;
  font-style: italic;

  &.is-error {
    color: var(--el-color-danger, #d6455d);
    font-style: normal;
  }
}
</style>
