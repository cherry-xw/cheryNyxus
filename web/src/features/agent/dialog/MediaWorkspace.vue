<script setup lang="ts">
/**
 * MediaWorkspace：媒体附件区域（拖拽上传 + 附件网格）。
 * 从 AgentDialog 拆出，纯展示 + add/remove 事件。
 */
import { CircleClose, UploadFilled } from "@element-plus/icons-vue";
import { computed, type Ref } from "vue";
import type { MediaAttachment } from "./useAgentDialogOptions";

const props = defineProps<{
  disabled: boolean;
  attachments: MediaAttachment[];
  hint: string;
  uploadQueue: Ref<import("element-plus").UploadUserFile[]>;
  uploading: boolean;
  hasPrimaryBrain: boolean;
}>();

const emit = defineEmits<{
  (e: "add", file: File): void;
  (e: "remove", attachment: MediaAttachment): void;
  (e: "mediaSelected", uploadFile: import("element-plus").UploadFile): void;
  (e: "update:uploadQueue", files: import("element-plus").UploadUserFile[]): void;
}>();

/**
 * el-upload 的 file-list 需要双向绑定，但 uploadQueue 是 prop（只读）。
 * 用 computed get/set 中转：set 时 emit update:uploadQueue，由父组件写回。
 */
const fileList = computed({
  get: () => props.uploadQueue,
  set: (v) => emit("update:uploadQueue", v),
});

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<template>
  <section class="media-workspace" aria-label="媒体附件">
    <div class="media-workspace-head">
      <div><strong>媒体附件</strong><span>图片、视频、音频</span></div>
      <span v-if="attachments.length" class="media-count">{{ attachments.length }} 个已附加</span>
    </div>
    <el-upload
      v-model:file-list="fileList"
      class="media-picker"
      drag
      :auto-upload="false"
      :show-file-list="false"
      accept="image/*,video/*,audio/*"
      :disabled="disabled || !hasPrimaryBrain"
      :on-change="(f: any) => $emit('mediaSelected', f)"
    >
      <el-icon class="media-picker-icon"><UploadFilled /></el-icon>
      <div class="el-upload__text">拖入媒体，或 <em>点击选择文件</em></div>
      <template #tip><div class="el-upload__tip">仅上传当前模型支持理解的媒体类型</div></template>
    </el-upload>
    <div v-if="attachments.length" class="media-attachments">
      <article v-for="attachment in attachments" :key="attachment.filename" class="media-attachment">
        <div class="media-preview">
          <img v-if="attachment.kind === 'image'" :src="attachment.previewUrl" :alt="attachment.filename" />
          <video v-else-if="attachment.kind === 'video'" :src="attachment.previewUrl" controls preload="metadata" />
          <audio v-else :src="attachment.previewUrl" controls preload="metadata" />
        </div>
        <div class="media-meta">
          <strong :title="attachment.filename">{{ attachment.filename }}</strong>
          <span>{{ attachment.kind === 'image' ? '图片' : attachment.kind === 'video' ? '视频' : '音频' }} · {{ formatFileSize(attachment.size) }}</span>
        </div>
        <el-button class="media-remove" circle text type="danger" :icon="CircleClose" :aria-label="`移除 ${attachment.filename}`" @click="$emit('remove', attachment)" />
      </article>
    </div>
    <div v-if="hint" class="media-hint" role="status">{{ hint }}</div>
  </section>
</template>

<style scoped lang="less">
@ink: #14161a;

.media-workspace {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.46);
}

.media-workspace-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;

  > div { display: flex; align-items: baseline; gap: 7px; }
  strong { color: fade(@ink, 80%); font-size: 12px; }
  span { color: fade(@ink, 46%); font-size: 10px; }
}

.media-count {
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(246, 183, 60, 0.15);
  color: #8c6114 !important;
  font-weight: 700;
}

.media-picker {
  :deep(.el-upload), :deep(.el-upload-dragger) { width: 100%; }
  :deep(.el-upload-dragger) {
    height: 82px;
    padding: 12px 10px;
    border-color: rgba(190, 132, 28, 0.32);
    border-radius: 8px;
    background: rgba(246, 183, 60, 0.045);
  }
  :deep(.el-upload__text) { margin-top: 0; color: fade(@ink, 60%); font-size: 12px; }
  :deep(.el-upload__text em) { color: #b8821f; font-style: normal; font-weight: 700; }
  :deep(.el-upload__tip) { margin-top: 3px; color: fade(@ink, 42%); font-size: 10px; }
}

.media-picker-icon { margin: 0 0 3px; color: #c58b20; font-size: 23px; }

.media-attachments { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; }

.media-attachment {
  position: relative;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  min-height: 58px;
  padding: 6px;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 7px;
  background: #fff;
}

.media-preview {
  width: 44px;
  height: 44px;
  overflow: hidden;
  border-radius: 5px;
  background: #f4f0e8;
  display: flex;
  align-items: center;
  justify-content: center;

  img, video { width: 100%; height: 100%; object-fit: cover; }
  audio { width: 100%; max-width: 44px; height: 30px; }
}

.media-meta {
  min-width: 0;
  display: grid;
  gap: 3px;
  strong { overflow: hidden; color: fade(@ink, 76%); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  span { color: fade(@ink, 44%); font-size: 10px; }
}

.media-remove { flex: none; }

.media-hint { color: fade(@ink, 52%); font-size: 10px; line-height: 1.3; }
</style>
