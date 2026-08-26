<script setup lang="ts">
/** EditorCard：文本编辑器选择。onMounted 拉取可用编辑器列表，支持自定义命令。 */
import { onMounted, ref } from 'vue'
import { agentApi, type EditorInfo, type GlobalConfigDto } from '@/application/backend/public'
import LabelTip from '../LabelTip.vue'

defineProps<{ global: GlobalConfigDto; no: number }>()

/** 编辑器选项列表（从后端获取） */
const editorOptions = ref<EditorInfo[]>([])
const editorLoading = ref(false)
const customEditor = ref('')

/** 加载编辑器列表 */
async function loadEditors(): Promise<void> {
  editorLoading.value = true
  try {
    editorOptions.value = await agentApi.listEditors()
  } catch (err) {
    // 加载失败时静默处理，不影响用户手动输入
    console.error('加载编辑器列表失败:', err)
  } finally {
    editorLoading.value = false
  }
}

onMounted(loadEditors)
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span>WORKBENCH
  </div>
  <div class="field">
    <LabelTip label="文本编辑器" tip="点击可用编辑器直接切换；留空使用系统默认" />
    <div class="editor-deck">
      <button
        type="button"
        :class="{ active: !global.textEditor }"
        @click="global.textEditor = undefined"
      >
        系统默认
      </button>
      <button
        v-for="editor in editorOptions.filter((item) => item.available).slice(0, 3)"
        :key="editor.command"
        type="button"
        :class="{ active: global.textEditor === editor.command }"
        @click="global.textEditor = editor.command"
      >
        {{ editor.name }}
      </button>
      <el-popover trigger="click" placement="bottom" :width="230">
        <template #reference
          ><button
            type="button"
            :class="{
              active:
                !!global.textEditor &&
                !editorOptions.some((item) => item.command === global.textEditor),
            }"
          >
            自定义
          </button></template
        >
        <div class="custom-editor">
          <el-input
            v-model="customEditor"
            placeholder="编辑器命令"
            @keydown.enter="global.textEditor = customEditor.trim() || undefined"
          /><button
            type="button"
            @click="global.textEditor = customEditor.trim() || undefined"
          >
            使用
          </button>
        </div>
      </el-popover>
    </div>
  </div>
  <div class="editor-status">
    <span
      v-for="editor in editorOptions.slice(0, 4)"
      :key="editor.command"
      :class="{ online: editor.available }"
      ><i />{{ editor.name }}</span
    ><small v-if="!editorOptions.length">未检测到编辑器，保存后使用系统默认</small>
  </div>
</template>

<style scoped lang="less">
@import './shared-neon.less';

.editor-status {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.editor-status span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 5.5%, transparent);
  font-size: 8px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.editor-status i {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #94a3b8;
}
.editor-status span.online i {
  background: #22d3ee;
  box-shadow: 0 0 5px #22d3ee;
}
.editor-status small {
  font-size: 8px;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
</style>
