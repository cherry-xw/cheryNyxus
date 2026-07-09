<script setup lang="ts">
/**
 * GlobalTab：全局配置（config.global），所有宠物共享的脾气。
 * supervision 默认监管 / thinking / stream / 各超时与上限 / logger / file_compression。
 */
import type { ConfigDto } from "@/services/agentApi";
import { SUPERVISIONS } from "../constants";

defineProps<{ draft: ConfigDto }>();
</script>

<template>
  <section class="sect">
    <p class="sect-hint">所有宠物共享的脾气。</p>
    <label class="field">
      <span class="lbl">supervision 默认监管</span>
      <el-select v-model="draft.global.supervision">
        <el-option v-for="s in SUPERVISIONS" :key="s" :label="s" :value="s" />
      </el-select>
      <span class="hint">auto=全自动 / confirm=关键事问你 / manual=事事问你。⚠️ 降级越低越危险。</span>
    </label>
    <div class="field-row">
      <el-checkbox
        :model-value="draft.global.thinking"
        @change="(v) => (draft.global.thinking = v as boolean)"
      >thinking 思考模式</el-checkbox>
      <el-checkbox
        :model-value="draft.global.stream"
        @change="(v) => (draft.global.stream = v as boolean)"
      >stream 流式输出（边想边说）</el-checkbox>
    </div>
    <div class="card-grid">
      <label class="field">
        <span class="lbl">sense_execute_timeout 感官超时(ms)</span>
        <el-input-number v-model="draft.global.sense_execute_timeout" :controls="false" />
      </label>
      <label class="field">
        <span class="lbl">approval_timeout 审批超时(ms)</span>
        <el-input-number v-model="draft.global.approval_timeout" :controls="false" />
      </label>
      <label class="field">
        <span class="lbl">maxLoopCount 循环上限</span>
        <el-input-number v-model="draft.global.maxLoopCount" :controls="false" />
        <span class="hint">⚠️ 调高烧钱</span>
      </label>
      <label class="field">
        <span class="lbl">bash_log_retention_hours 日志保留(h)</span>
        <el-input-number v-model="draft.global.bash_log_retention_hours" :controls="false" />
      </label>
    </div>

    <template v-if="draft.global.logger">
      <h4 class="sub-title">日志 logger</h4>
      <div class="card-grid">
        <label class="field">
          <span class="lbl">level 等级</span>
          <el-select v-model="draft.global.logger.level">
            <el-option v-for="l in ['debug', 'info', 'warn', 'error', 'silent'] as const" :key="l" :label="l" :value="l" />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">format 格式</span>
          <el-select v-model="draft.global.logger.format">
            <el-option label="plain" value="plain" />
            <el-option label="json" value="json" />
          </el-select>
        </label>
        <div class="field">
          <span class="lbl">output 输出位置</span>
          <el-checkbox-group
            :model-value="draft.global.logger.output ?? []"
            class="chk-list"
            @change="(v) => (draft.global.logger.output = v as ('console' | 'file')[])"
          >
            <el-checkbox value="console">console</el-checkbox>
            <el-checkbox value="file">file</el-checkbox>
          </el-checkbox-group>
        </div>
        <div class="field-row">
          <el-checkbox
            :model-value="draft.global.logger.timestamp"
            @change="(v) => (draft.global.logger.timestamp = v as boolean)"
          >timestamp 时间戳</el-checkbox>
          <el-checkbox
            :model-value="draft.global.logger.location"
            @change="(v) => (draft.global.logger.location = v as boolean)"
          >location 调用位置</el-checkbox>
        </div>
      </div>
    </template>

    <template v-if="draft.global.file_compression">
      <h4 class="sub-title">文件压缩 file_compression</h4>
      <div class="card-grid">
        <label class="field">
          <span class="lbl">truncate_threshold 截断阈值(B)</span>
          <el-input-number v-model="draft.global.file_compression.truncate_threshold" :controls="false" />
        </label>
        <label class="field">
          <span class="lbl">truncate_preview_lines 保留行数</span>
          <el-input-number v-model="draft.global.file_compression.truncate_preview_lines" :controls="false" />
        </label>
        <label class="field">
          <span class="lbl">drain_preview_count 模板实例数</span>
          <el-input-number v-model="draft.global.file_compression.drain_preview_count" :controls="false" />
        </label>
        <label class="field">
          <span class="lbl">log_file_extensions 日志扩展名（逗号分隔）</span>
          <el-input
            :value="(draft.global.file_compression.log_file_extensions ?? []).join(', ')"
            @input="draft.global.file_compression.log_file_extensions = $event.split(',').map((s) => s.trim()).filter(Boolean)"
          />
        </label>
      </div>
    </template>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
