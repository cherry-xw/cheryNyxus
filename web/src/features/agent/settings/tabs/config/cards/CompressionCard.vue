<script setup lang="ts">
/** CompressionCard：读取大文件内容压缩阈值 + 日志扩展名白名单增删。 */
import { ref } from 'vue'
import type { GlobalConfigDto } from '@/services/agentApi'
import NeonNumberControl from '../../../controls/NeonNumberControl.vue'

type CompressionCfg = NonNullable<GlobalConfigDto['file_compression']>

const props = defineProps<{ compression: CompressionCfg; no: number }>()

const newLogExtension = ref('')

function addLogExtension(): void {
  const value = newLogExtension.value.trim()
  if (!value) return
  const current = props.compression.log_file_extensions ?? []
  if (!current.includes(value))
    props.compression.log_file_extensions = [...current, value]
  newLogExtension.value = ''
}
function removeLogExtension(value: string): void {
  props.compression.log_file_extensions = (props.compression.log_file_extensions ?? []).filter(
    (item) => item !== value,
  )
}
</script>

<template>
  <div class="block-kicker">
    <span class="kicker-no">{{ no }}</span>FILE SIGNAL
  </div>
  <h3 class="sub-title">读取大文件内容压缩</h3>
  <p class="block-summary"><code>read_file</code> 返回层压缩；不修改磁盘文件。</p>
  <div class="neon-grid">
    <NeonNumberControl
      v-model="compression.truncate_threshold"
      label="大文件阈值"
      tip="超过此字节数只返回预览"
      placeholder="102400"
      unit="B"
      :step="10240"
      :min="1"
    />
    <NeonNumberControl
      v-model="compression.truncate_preview_lines"
      label="截断预览"
      tip="超大普通文件保留的开头行数"
      placeholder="100"
      unit="行"
      :step="20"
      :min="1"
    />
    <NeonNumberControl
      v-model="compression.drain_preview_count"
      label="日志样例"
      tip="每种重复格式保留的样例数"
      placeholder="3"
      unit="条"
      :step="1"
      :min="1"
    />
    <div class="extension-magazine">
      <span class="lbl">日志扩展名</span>
      <div>
        <button
          v-for="ext in compression.log_file_extensions ?? []"
          :key="ext"
          type="button"
          title="点击移除"
          @click="removeLogExtension(ext)"
        >
          {{ ext }} ×</button
        ><el-popover trigger="click" placement="bottom" :width="190"
          ><template #reference
            ><button type="button" class="add-extension">＋ 添加</button></template
          >
          <div class="custom-editor">
            <el-input
              v-model="newLogExtension"
              placeholder=".log"
              @keydown.enter="addLogExtension"
            /><button type="button" @click="addLogExtension">加入</button>
          </div></el-popover
        >
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './shared-neon.less';

.extension-magazine {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.extension-magazine > div {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}
.extension-magazine button {
  height: 24px;
  padding: 2px 6px;
  border: 1px solid rgba(139, 92, 246, 0.17);
  border-radius: 7px;
  background: rgba(245, 243, 255, 0.78);
  color: #6d28d9;
  font-size: 9px;
  cursor: pointer;
}
.extension-magazine .add-extension {
  border-style: dashed;
  background: transparent;
  color: #6366f1;
}
</style>
