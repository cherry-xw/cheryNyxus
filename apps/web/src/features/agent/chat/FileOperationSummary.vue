<script setup lang="ts">
import type { FileOperationRecord } from '@/application/files/public'
defineProps<{ operations: FileOperationRecord[] }>()
const executions: Record<FileOperationRecord['executionStatus'], string> = {
  waiting_approval: '等待批准', queued: '排队中', running: '执行中', succeeded: '执行成功', partial: '部分执行成功', failed: '执行失败', cancel_requested: '已请求取消', cancelled: '已取消', result_unknown: '远端结果未知',
}
const deliveries: Record<FileOperationRecord['deliveryStatus'], string> = {
  pending_save: '尚未保存', saving: '保存中', saved: '已保存', partial_saved: '部分文件已保存', delivery_failed: '保存失败',
}
const inspections: Record<FileOperationRecord['inspectionStatus'], string> = {
  not_requested: '未要求检查', pending_inspection: '等待必需检查', passed: '检查通过', failed_inspection: '不符合检查要求', inspection_error: '检查执行失败',
}
</script>
<template>
  <ul class="file-operations" aria-label="文件处理状态">
    <li v-for="operation in operations" :key="operation.operationId">
      <dl>
        <div><dt>执行</dt><dd>{{ executions[operation.executionStatus] }}</dd></div>
        <div><dt>保存</dt><dd>{{ deliveries[operation.deliveryStatus] }}</dd></div>
        <div><dt>检查</dt><dd>{{ inspections[operation.inspectionStatus] }}</dd></div>
      </dl>
      <p v-if="operation.imageCount">期望 {{ operation.imageCount.desiredCount }} 张 · {{ operation.imageCount.effectiveCount === undefined ? '返回张数不可控或未确认' : `${operation.imageCount.countControl === 'maximum' ? '最多' : '请求'} ${operation.imageCount.effectiveCount} 张` }}<template v-if="operation.receivedImageCount !== undefined"> · 收到 {{ operation.receivedImageCount }} 张</template><template v-if="operation.savedImageCount !== undefined"> · 已保存 {{ operation.savedImageCount }} 张</template><template v-if="operation.reportedFailedImageCount !== undefined"> · 服务报告失败 {{ operation.reportedFailedImageCount }} 张</template></p>
      <p v-if="operation.imageCountWarning" role="status">{{ operation.imageCountWarning }}</p>
      <p v-if="operation.error" role="status">{{ operation.error.message }}</p>
      <p v-if="operation.inspectionSummary">检查结论：{{ operation.inspectionSummary }}</p>
      <p v-if="operation.executionStatus === 'result_unknown'">远端可能仍在处理，不能直接重试生成以免重复收费。</p>
      <small>操作 ID：{{ operation.operationId }}</small>
    </li>
  </ul>
</template>
<style scoped>
.file-operations { list-style:none; padding:0; margin:8px 0; color:var(--ink); font-size:14px; overflow-wrap:anywhere; }
li + li { border-top:1px solid var(--border); padding-top:8px; margin-top:8px; }
dl { display:flex; flex-wrap:wrap; gap:8px 16px; margin:0; } dl div { display:flex; gap:6px; } dt { font-weight:600; } dd { margin:0; } p { margin:6px 0; line-height:1.5; } small { display:block; margin-top:6px; }
</style>
