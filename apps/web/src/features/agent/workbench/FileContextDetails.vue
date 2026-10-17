<script setup lang="ts">
import { useFileContextDetails } from './useFileContextDetails'
const props = defineProps<{ chatId: string }>()
const { data, error, loading, load } = useFileContextDetails(() => props.chatId)
const actions = { native: '携带图片或文件内容', extract: '携带提取文字', tool: '通过工具理解', describe: '仅携带文字说明', omit: '未包含' }
const phases = { prepared: '已准备', sent: '已发出', completed: '请求已完成', failed_before_send: '发送前失败', result_unknown: '已发出但结果未确认' }
const sources: Record<string, string> = { observation: '已有图片理解记录', user: '用户说明（未经系统验证）' }
</script>
<template>
  <section class="file-context" :aria-busy="loading" aria-label="文件上下文详情">
    <header><h3>最近含文件的请求</h3><button type="button" :disabled="loading" @click="load">刷新文件详情</button></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="loading" role="status">正在读取…</p>
    <template v-if="data">
      <p>会话：{{ chatId }}</p>
      <p v-if="data.updatedAt">记录时间：{{ new Date(data.updatedAt).toLocaleString() }}</p>
      <p v-if="data.requestId">请求标识：{{ data.requestId }}</p>
      <p v-if="data.phase">发送阶段：{{ phases[data.phase] }}</p>
      <p v-else-if="data.status !== 'not_prepared'">未记录发送阶段。</p>
      <p>这里只显示此会话最近一次文件请求；准备内容、用量预检或请求完成，都不能证明模型已理解图片。</p>
      <p v-if="data.usage">{{ data.usage.assetVersions }} 个文件版本 · {{ (data.usage.binaryBytes / 1024).toFixed(1) }} KiB 文件内容 · {{ data.usage.extractedChars }} 字提取文字</p>
      <p v-if="data.status === 'not_prepared'">此会话还没有准备过文件请求。</p>
      <p v-else-if="!data.plan.length">最近请求没有文件处理项。</p>
      <template v-else>
        <p v-if="data.officialPreflight === 'succeeded' && data.inputTokens !== undefined">官方输入预检：{{ data.inputTokens }} token（包含本次输入及工具，不是最终收费量）。</p>
        <p v-else-if="data.officialPreflight === 'pending'">本次请求尚未完成用量预检。</p>
        <p v-else>文字与工具的本地保守估算：{{ data.estimatedTextTokens ?? '尚未计算' }} token；媒体 token 未知。{{ data.officialPreflight === 'unavailable' ? '官方预检暂不可用，已使用估算。' : '当前接口没有可用的官方预检。' }}</p>
        <p>文件保存在历史中，不代表每轮都发送。</p>
      </template>
      <details v-if="data.policy">
        <summary>本次采用的图片策略</summary>
        <p>自动携带：{{ data.policy.mode === 'current' ? '仅当前轮' : data.policy.mode === 'unlimited' ? '不按轮数过滤（仍受预算和整体压缩限制）' : `最近 ${data.policy.recentUserTurns ?? 3} 轮（含首次发送轮）` }}</p>
        <p>到期后的文字：{{ data.policy.replacement === 'keywords' ? '仅关键词' : '简短描述与关键词' }}</p>
        <p>缺少描述时：{{ data.policy.missingDescription === 'inspect' ? '自动调用指定识图服务补充' : '只使用已有信息' }}</p>
        <p v-if="data.policy.missingDescription === 'inspect'">补描述服务：{{ data.policy.serviceId ?? '未选择' }}</p>
        <p>说明字符上限：单图 {{ data.policy.maxDescriptionChars ?? 600 }}，本次总计 {{ data.policy.maxTotalDescriptionChars ?? 6000 }}。</p>
      </details>
      <ol><li v-for="part in data.plan" :key="`${part.messageId}:${part.partId}`">
        <span>{{ part.originalName ?? part.assetId }}</span>
        <span>{{ part.variant === 'adapted' ? '适配版本' : '原始文件' }} · {{ actions[part.action] }}</span>
        <span>{{ part.reason }}<template v-if="part.truncated">；文字已截断</template></span>
        <details><summary>处理详情</summary>
          <p>文件：{{ part.assetId }}<br />固定版本：{{ part.assetVersionId }}</p>
          <p v-if="part.targetId">处理工具或服务：{{ part.targetId }}</p>
          <p v-if="part.operationId">处理操作：{{ part.operationId }}</p>
          <p v-if="part.ageUserTurns !== undefined">距采用图片已过 {{ part.ageUserTurns }} 个用户轮。</p>
          <p>{{ (part.binaryBytes / 1024).toFixed(1) }} KiB 文件内容 · {{ part.extractedChars }} 字文字</p>
          <template v-if="part.description">
            <p class="description-text">文字说明：{{ part.description.text || '尚无视觉描述' }}</p>
            <p v-if="part.description.keywords.length">关键词：{{ part.description.keywords.join('、') }}</p>
            <p>来源：{{ sources[part.description.source] ?? part.description.source }}</p>
            <p>适用范围：{{ part.description.scope }}</p>
            <p>说明时间：{{ new Date(part.description.createdAt).toLocaleString() }}</p>
            <p v-if="part.description.operationId">来源操作：{{ part.description.operationId }}</p>
          </template>
          <p v-else-if="part.action === 'describe'">尚无视觉描述，仅保留已有文件信息。</p>
        </details>
      </li></ol>
    </template>
  </section>
</template>
<style scoped>
.file-context { border-top:1px solid var(--border); padding-top:12px; font-size:14px; color:var(--ink); }
header { display:flex; align-items:center; flex-wrap:wrap; gap:8px; } h3 { margin:0; font:inherit; font-weight:600; }
p { line-height:1.5; overflow-wrap:anywhere; } ol { padding-left:20px; } li { margin-block:12px; overflow-wrap:anywhere; } li span { display:block; margin-top:4px; }
summary { cursor:pointer; margin-top:8px; } .description-text { white-space:pre-wrap; }
button { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); padding:5px 8px; cursor:pointer; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
