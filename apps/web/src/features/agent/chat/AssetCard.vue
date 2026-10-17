<script setup lang="ts">
import type { MessagePart } from '@/application/files/public'
import { useAssetCard } from './useAssetCard'
const props = defineProps<{ part: Extract<MessagePart, { type: 'asset' }>; chatId?: string }>()
const { asset, filename, error, busy, previewOpen, previewUrl, previewText, previewKind, canReference, action, load, clearPreview, referenceTargets, referenceTargetOpen, selectedTargetId, confirmReference,
  isImage, descriptionOpen, description, descriptionError, descriptionLoading, loadDescription, toggleDescription } = useAssetCard(props)
</script>
<template>
  <section class="asset-card" :aria-busy="busy">
    <span class="filename">{{ filename }}</span>
    <small>{{ asset ? `${asset.mimeType} · ${(asset.sizeBytes / 1024).toFixed(1)} KiB` : '正在读取文件信息' }} · {{ part.variant === 'adapted' ? '适配版本' : '原始文件' }}<template v-if="part.usage === 'reference-only'"> · 仅附文件，本次不读取内容</template></small>
    <div class="actions"><button type="button" :disabled="busy || !asset" @click="action('preview')">预览</button><button type="button" :disabled="busy || !asset" @click="action('download')">下载</button><button v-if="canReference" type="button" :disabled="busy || !asset" @click="action('reference')">用于下一条消息</button></div>
    <p v-if="error" role="alert">{{ error }} <button type="button" @click="load">重试读取</button></p>
    <details v-if="isImage" :open="descriptionOpen" @toggle="toggleDescription(($event.target as HTMLDetailsElement).open)">
      <summary>文字说明与来源</summary>
      <div :aria-busy="descriptionLoading">
        <p v-if="!chatId">需要在所属会话中查询文字说明。</p>
        <p v-else-if="descriptionLoading" role="status">正在查询已有说明…</p>
        <p v-else-if="descriptionError" role="alert">{{ descriptionError }} <button type="button" @click="loadDescription">重试查询</button></p>
        <template v-else-if="description">
          <p class="description-text">{{ description.text || '尚无视觉描述' }}</p>
          <p v-if="description.keywords.length">关键词：{{ description.keywords.join('、') }}</p>
          <details><summary>来源与固定版本</summary>
            <p>来源：{{ description.source === 'observation' ? '已有图片理解记录' : description.source === 'user' ? '用户说明（未经系统验证）' : description.source }}</p>
            <p>适用范围：{{ description.scope }}</p>
            <p>记录时间：{{ new Date(description.createdAt).toLocaleString() }}</p>
            <p>文件：{{ part.assetId }}<br />固定版本：{{ part.assetVersionId }}</p>
            <p v-if="description.operationId">来源操作：{{ description.operationId }}</p>
          </details>
        </template>
        <p v-else>尚无视觉描述。</p>
        <p>这里只查询已有文字，不调用识图服务；有说明不代表当前模型看到了原图。</p>
      </div>
    </details>
    <el-dialog v-model="previewOpen" :title="filename" width="min(900px, 92vw)" append-to-body @closed="clearPreview">
      <img v-if="previewKind === 'image' && previewUrl" :src="previewUrl" :alt="filename" />
      <audio v-else-if="previewKind === 'audio' && previewUrl" :src="previewUrl" controls />
      <video v-else-if="previewKind === 'video' && previewUrl" :src="previewUrl" controls />
      <template v-else-if="previewKind === 'text'"><p>只读预览，最多显示前 256 KiB；完整内容请下载。</p><pre>{{ previewText }}</pre></template>
      <p v-else>无法在此预览，可下载原文件。</p>
    </el-dialog>
    <el-dialog v-model="referenceTargetOpen" title="选择文件引用的目标会话" width="min(600px, 92vw)" append-to-body>
      <label>目标会话<select v-model="selectedTargetId" :disabled="busy"><option value="" disabled>请选择目标输入框</option><option v-for="target in referenceTargets" :key="target.id" :value="target.id">{{ target.label }}</option></select></label>
      <p>只加入所选会话的下一条消息草稿，不会立即发送。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template #footer><button type="button" :disabled="busy || !selectedTargetId" @click="confirmReference">加入所选草稿</button></template>
    </el-dialog>
  </section>
</template>
<style scoped>
.asset-card { display:flex; flex-direction:column; gap:8px; border:1px solid var(--border-strong); padding:12px; margin:8px 0; min-width:0; font-size:16px; color:var(--ink); background:var(--surface); }
.filename,small,p,pre { overflow-wrap:anywhere; } small { font-size:14px; } .actions { display:flex; flex-wrap:wrap; gap:8px; }
button { border:1px solid var(--border-strong); border-radius:0; background:var(--surface); color:var(--ink); padding:6px 10px; font:inherit; cursor:pointer; } button:disabled { cursor:default; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
summary { cursor:pointer; overflow-wrap:anywhere; } .description-text { white-space:pre-wrap; } details p { margin-block:8px; }
img,video { max-width:100%; max-height:65vh; object-fit:contain; } audio { max-width:100%; } pre { white-space:pre-wrap; max-height:60vh; overflow:auto; }
</style>
