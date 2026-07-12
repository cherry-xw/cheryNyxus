<script setup lang="ts">
/**
 * GlobalTab：全局配置（config.global），所有宠物共享的脾气。
 * supervision 默认监管 / thinking / stream / 各超时与上限 / logger / file_compression。
 */
import type { ConfigDto } from "@/services/agentApi";
import { SUPERVISIONS, SUPERVISION_LABEL } from "../constants";
import LabelTip from "../components/LabelTip.vue";

defineProps<{ draft: ConfigDto }>();
</script>

<template>
  <section class="sect">
    <p class="sect-hint">所有会话共用的运行规则。留空的数值将使用系统默认值，输入后才会覆盖默认设置。</p>
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
    <div class="card-grid">
      <label class="field">
        <LabelTip label="工具执行超时（ms）" tip="sense_execute_timeout：单次工具执行的最长等待时间" />
        <el-input-number v-model="draft.global.sense_execute_timeout" :controls="false" placeholder="默认 30000" />
      </label>
      <label class="field">
        <LabelTip label="审批等待（ms）" tip="approval_timeout：等待人工审批的时间；超时按拒绝处理" />
        <el-input-number v-model="draft.global.approval_timeout" :controls="false" placeholder="默认不超时" />
      </label>
      <label class="field">
        <LabelTip label="单轮工具调用上限" tip="maxLoopCount：单轮会话可连续调用工具的次数" />
        <el-input-number v-model="draft.global.maxLoopCount" :controls="false" placeholder="默认 30" />
        <span class="hint">⚠️ 调高烧钱</span>
      </label>
      <label class="field">
        <LabelTip label="命令日志保留（小时）" tip="bash_log_retention_hours：仅清理 execute_command 产生的命令日志，不影响应用运行日志" />
        <el-input-number v-model="draft.global.bash_log_retention_hours" :controls="false" placeholder="默认 24" />
      </label>
    </div>

    <template v-if="draft.global.logger">
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
    </template>

    <template v-if="draft.global.file_compression">
      <h3 class="sub-title">读取大文件时的内容压缩</h3>
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
    </template>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
