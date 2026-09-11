<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core'
import { Link } from '@element-plus/icons-vue'
import type { WorkflowGraphNodeData } from './graphModel'

type UnresolvedData = Extract<WorkflowGraphNodeData, { kind: 'unresolved' }>
defineProps<NodeProps<UnresolvedData>>()
</script>

<template>
  <div class="workflow-node-root">
    <Handle type="target" :position="Position.Left" />
    <div class="workflow-unresolved-node">
      <span><Link aria-hidden="true" />{{ data.title }}</span>
      <small>{{ data.detail }}</small>
    </div>
  </div>
</template>
