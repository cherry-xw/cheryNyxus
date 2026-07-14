<script setup lang="ts">
/**
 * GlobalTab：全局配置（config.global），所有宠物共享的脾气。
 * supervision 默认监管 / thinking / stream / 各超时与上限 / logger / file_compression / memory。
 * 四段内容视为 4 张虚拟卡，由 TabShell 的序号按钮导航（logger / file_compression 可能不存在，memory 常驻但可能需初始化）。
 */
import { computed, ref, onMounted, watch } from "vue";
import type { ConfigDto, EditorInfo } from "@/services/agentApi";
import { agentApi } from "@/services/agentApi";
import { SUPERVISIONS, SUPERVISION_LABEL } from "../constants";
import LabelTip from "../components/LabelTip.vue";
import TabShell, { type IndexItem } from "../components/TabShell.vue";

const props = defineProps<{ draft: ConfigDto }>();

/** 编辑器选项列表（从后端获取） */
const editorOptions = ref<EditorInfo[]>([]);
const editorLoading = ref(false);

/** 加载编辑器列表 */
async function loadEditors(): Promise<void> {
  editorLoading.value = true;
  try {
    editorOptions.value = await agentApi.listEditors();
  } catch (err) {
    // 加载失败时静默处理，不影响用户手动输入
    console.error("加载编辑器列表失败:", err);
  } finally {
    editorLoading.value = false;
  }
}

onMounted(loadEditors);

/** memory 段可能未在 config.yaml 中定义（config.get 返回 undefined），初始化空白对象供 v-model 绑定。 */
watch(
  () => props.draft.memory,
  (mem) => {
    if (!mem) {
      props.draft.memory = { max_count: undefined, max_chars: undefined };
    }
  },
  { immediate: true },
);

/** 序号按钮列表：默认监管常驻；logger / file_compression / memory 按配置动态生成。 */
const indexItems = computed<IndexItem[]>(() => {
  const items: IndexItem[] = [
    { label: "默认监管", anchor: "default", brief: "监管模式 / 思考 / 流式 / 超时上限" },
  ];
  if (props.draft.global.logger) {
    items.push({ label: "应用日志", anchor: "logger", brief: "等级 / 格式 / 输出位置" });
  }
  if (props.draft.global.file_compression) {
    items.push({ label: "大文件压缩", anchor: "compression", brief: "阈值 / 预览行数 / 日志扩展名" });
  }
  items.push({ label: "项目记忆", anchor: "memory", brief: "活跃条数上限 / 单条字数建议" });
  return items;
});
</script>

<template>
  <TabShell :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">所有会话共用的运行规则。留空的数值将使用系统默认值，输入后才会覆盖默认设置。</p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line"><b>内容</b><span>{{ item.brief as string }}</span></div>
      </div>
    </template>

    <div class="card global-section" data-anchor="default">
      <label class="field">
        <span class="lbl">默认监管</span>
        <el-select v-model="draft.global.supervision">
          <el-option v-for="s in SUPERVISIONS" :key="s" :label="SUPERVISION_LABEL[s]" :value="s" />
        </el-select>
        <span class="hint">自动=全自动 / 确认=关键事问你 / 手动=事事问你。⚠️ 降级越低越危险。</span>
      </label>
      <div class="field-row">
        <el-checkbox
          :model-value="draft.global.thinking"
          @change="(v: unknown) => (draft.global.thinking = v as boolean)"
        >思考模式</el-checkbox>
        <el-checkbox
          :model-value="draft.global.stream"
          @change="(v: unknown) => (draft.global.stream = v as boolean)"
        >流式输出（边想边说）</el-checkbox>
      </div>
      <label class="field">
        <LabelTip label="文本编辑器" tip="用于打开配置文件的编辑器（如 VSCode、记事本），留空使用系统默认" />
        <el-select
          v-model="draft.global.textEditor"
          filterable
          allow-create
          clearable
          placeholder="选择或输入编辑器命令"
          :loading="editorLoading"
        >
          <el-option
            v-for="editor in editorOptions"
            :key="editor.command"
            :label="editor.name"
            :value="editor.command"
            :disabled="!editor.available"
          />
        </el-select>
      </label>
      <div class="one-line-grid">
        <label class="field">
          <LabelTip label="工具执行超时（ms）" tip="工具执行的最长等待时间，超过此时间将进入后台执行" />
          <el-input-number v-model="draft.global.sense_execute_timeout" :controls="false" placeholder="默认 30000" />
        </label>
        <label class="field">
          <LabelTip label="审批等待（ms）" tip="approval_timeout：等待人工审批的时间；超时按拒绝处理" />
          <el-input-number v-model="draft.global.approval_timeout" :controls="false" placeholder="默认不超时" />
        </label>
        <label class="field">
          <LabelTip label="单轮工具调用上限" tip="maxLoopCount：单轮会话可连续调用工具的次数" />
          <el-input-number v-model="draft.global.maxLoopCount" :controls="false" placeholder="默认 30" />
        </label>
        <label class="field">
          <LabelTip label="命令日志保留（小时）" tip="bash_log_retention_hours：仅清理 execute_command 产生的命令日志，不影响应用运行日志" />
          <el-input-number v-model="draft.global.bash_log_retention_hours" :controls="false" placeholder="默认 24" />
        </label>
      </div>
    </div>

    <div v-if="draft.global.logger" class="card global-section" data-anchor="logger">
      <h3 class="sub-title">应用日志</h3>
      <div class="card-grid">
        <label class="field">
          <span class="lbl">等级</span>
          <el-select v-model="draft.global.logger!.level">
            <el-option v-for="l in ['debug', 'info', 'warn', 'error', 'silent'] as const" :key="l" :label="l" :value="l" />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">格式</span>
          <el-select v-model="draft.global.logger!.format">
            <el-option label="plain" value="plain" />
            <el-option label="json" value="json" />
          </el-select>
        </label>
        <div class="field">
          <span class="lbl">输出位置</span>
          <el-checkbox-group
            :model-value="draft.global.logger!.output ?? []"
            class="chk-list"
            @change="(v: unknown) => (draft.global.logger!.output = v as ('console' | 'file')[])"
          >
            <el-checkbox value="console">console</el-checkbox>
            <el-checkbox value="file">file</el-checkbox>
          </el-checkbox-group>
        </div>
        <div class="field-row">
          <el-checkbox
            :model-value="draft.global.logger!.timestamp"
            @change="(v: unknown) => (draft.global.logger!.timestamp = v as boolean)"
          >时间戳</el-checkbox>
          <el-checkbox
            :model-value="draft.global.logger!.location"
            @change="(v: unknown) => (draft.global.logger!.location = v as boolean)"
          >调用位置</el-checkbox>
        </div>
      </div>
    </div>

    <div v-if="draft.global.file_compression" class="card global-section" data-anchor="compression">
      <h3 class="sub-title">读取大文件内容压缩</h3>
      <p class="sect-hint">此设置只影响 <code>read_file</code> 返回给模型的内容，不会修改磁盘文件：超大普通文件会截断，日志文件会按重复模式压缩。</p>
      <div class="card-grid">
        <label class="field">
          <LabelTip label="大文件阈值（B）" tip="truncate_threshold：超过此字节数的普通文件仅返回预览" />
          <el-input-number v-model="draft.global.file_compression.truncate_threshold" :controls="false" placeholder="默认 102400" />
        </label>
        <label class="field">
          <LabelTip label="截断预览行数" tip="truncate_preview_lines：超大普通文件保留开头的行数" />
          <el-input-number v-model="draft.global.file_compression.truncate_preview_lines" :controls="false" placeholder="默认 100" />
        </label>
        <label class="field">
          <LabelTip label="每类日志样例数" tip="drain_preview_count：日志压缩后，每种重复格式保留多少条样例" />
          <el-input-number v-model="draft.global.file_compression.drain_preview_count" :controls="false" placeholder="默认 3" />
        </label>
        <label class="field">
          <span class="lbl">日志扩展名（逗号分隔）</span>
          <el-input
            :value="(draft.global.file_compression.log_file_extensions ?? []).join(', ')"
            @input="draft.global.file_compression.log_file_extensions = $event.split(',').map((s: string) => s.trim()).filter(Boolean)"
          />
        </label>
      </div>
    </div>
    <div class="card global-section" data-anchor="memory">
      <h3 class="sub-title">项目记忆</h3>
      <p class="sect-hint">记忆以 Markdown 文件存储在 <code>.chery/memory/</code>（或 workspace 模式下的项目目录）。超出条数上限时旧记忆自动归档到 history。</p>
      <div class="card-grid">
        <label class="field">
          <LabelTip label="最大条数" tip="max_count：活跃记忆最大条数，超限触发自动淘汰归档" />
          <el-input-number v-model="draft.memory!.max_count" :controls="false" :min="1" placeholder="默认 15" />
        </label>
        <label class="field">
          <LabelTip label="单条字数建议" tip="max_chars：单条记忆正文的软性字数建议，AI 写入时会参考此值但非硬性截断" />
          <el-input-number v-model="draft.memory!.max_chars" :controls="false" :min="1" placeholder="默认 500" />
        </label>
      </div>
    </div>
  </TabShell>
</template>

<style scoped lang="less">
@import "../shared.less";

.global-section {
  // 段与段之间稍微多留一点间距，让导航切换后视觉上有区分。
  gap: 10px;
}

.one-line-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
</style>
