<script setup lang="ts">
import { Close, Connection, Refresh, Warning } from '@element-plus/icons-vue'
import type { NyxusContentSelection } from '@/features/pets/nyxus/public'
import type { WorkflowStepDetailModel } from './workflowStepDetails'

defineProps<{
  model: WorkflowStepDetailModel
  loading: boolean
  error?: string
}>()

const emit = defineEmits<{
  close: []
  retry: []
  selectContent: [selection: NyxusContentSelection, graphNodeId: string]
}>()
</script>

<template>
  <aside
    id="workflow-step-detail"
    class="workflow-step-detail nodrag nopan nowheel"
    role="region"
    :aria-label="`${model.title}步骤详情`"
    @pointerdown.stop
    @wheel.stop
    @keydown.esc.stop="emit('close')"
  >
    <header>
      <span>
        <strong>{{ model.title }}</strong>
        <small>{{ model.scopeText }}</small>
      </span>
      <el-tooltip content="关闭步骤详情" placement="bottom">
        <button type="button" aria-label="关闭步骤详情" @click="emit('close')">
          <Close aria-hidden="true" />
        </button>
      </el-tooltip>
    </header>

    <p class="workflow-step-detail-description">{{ model.detail }}</p>
    <p class="workflow-step-detail-coverage">{{ model.coverage }}</p>

    <div v-if="loading" class="workflow-step-detail-state" role="status">
      正在读取固定范围内的步骤记录…
    </div>
    <div v-else-if="error" class="workflow-step-detail-state is-error" role="alert">
      <Warning aria-hidden="true" />
      <span>{{ error }}</span>
      <button type="button" @click="emit('retry')">
        <Refresh aria-hidden="true" />
        重试
      </button>
    </div>
    <div v-else class="workflow-step-detail-body">
      <div v-if="model.legacy" class="workflow-step-detail-state" role="status">
        <Warning aria-hidden="true" />
        这是旧记录，只有概要，未保存独立步骤实例。
      </div>
      <div v-if="model.gapCount" class="workflow-step-detail-state" role="status">
        <Warning aria-hidden="true" />
        当前范围存在 {{ model.gapCount }} 处记录缺口，空白不能视为成功。
      </div>
      <ol v-if="model.instances.length" class="workflow-step-instance-list">
        <li v-for="instance in model.instances" :key="instance.id">
          <div class="workflow-step-instance-head">
            <span>{{ instance.label }}</span>
            <small :class="`state-${instance.status}`">{{ instance.statusText }}</small>
          </div>
          <small v-if="instance.scopeText" class="workflow-step-instance-scope">
            {{ instance.scopeText }}
          </small>
          <div v-if="instance.anchors.length" class="workflow-step-anchor-list">
            <el-tooltip
              v-for="anchor in instance.anchors"
              :key="anchor.key"
              :content="anchor.available ? anchor.label : anchor.unavailableReason"
              placement="bottom"
            >
              <span class="workflow-step-anchor-tip">
                <button
                  type="button"
                  :disabled="!anchor.available"
                  @click="
                    anchor.graphNodeId &&
                    emit('selectContent', anchor.selection, anchor.graphNodeId)
                  "
                >
                  <Connection aria-hidden="true" />
                  {{ anchor.available ? anchor.label : '关联内容不可用' }}
                </button>
              </span>
            </el-tooltip>
          </div>
          <p v-else>此实例没有内容关联，不会打开其他消息。</p>
        </li>
      </ol>
      <div v-else-if="!model.legacy" class="workflow-step-detail-state" role="status">
        当前范围没有独立步骤记录。
      </div>
    </div>
  </aside>
</template>

<style scoped lang="less" src="./WorkflowStepDetails.styles.less"></style>
