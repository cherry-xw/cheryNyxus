<script setup lang="ts">
/**
 * SubagentsTab：子 agent（config.subagents）配置。
 * 主宠派出的助手，各配大脑与感官。删除走 ConfirmPopover 二次确认。
 */
import { ref } from "vue";
import { Delete } from "@element-plus/icons-vue";
import type { ConfigDto } from "@/services/agentApi";
import ConfirmPopover from "../ConfirmPopover.vue";

const props = defineProps<{ draft: ConfigDto }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

const newSubagentType = ref("");

function addSubagent(): void {
  const type = newSubagentType.value.trim();
  if (!type) return;
  if (!props.draft.subagents) props.draft.subagents = {};
  if (props.draft.subagents[type]) {
    emit("error", `子 agent "${type}" 已存在`);
    return;
  }
  props.draft.subagents[type] = { brain: "", senseGroups: [] };
  newSubagentType.value = "";
}
function removeSubagent(type: string): void {
  if (!props.draft.subagents) return;
  delete props.draft.subagents[type];
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">主宠遇到读代码/读图/搜索时可派出的助手，各配大脑与感官。</p>
    <article v-for="(cfg, type) in draft.subagents" :key="type" class="card">
      <header class="card-head">
        <span class="card-name">{{ type }}</span>
        <ConfirmPopover :title="`确认删除子 agent「${type}」？`" @confirm="removeSubagent(type as string)">
          <template #trigger>
            <button type="button" class="icon-btn danger" aria-label="删除">
              <Delete class="ico" />
            </button>
          </template>
        </ConfirmPopover>
      </header>
      <label class="field">
        <span class="lbl">大脑 brain</span>
        <el-select v-model="cfg.brain">
          <el-option label="（未选）" value="" />
          <el-option v-for="(_, bname) in draft.llm.brain" :key="bname" :label="String(bname)" :value="bname" />
        </el-select>
      </label>
      <div class="field">
        <span class="lbl">感官组 senseGroups</span>
        <el-checkbox-group
          :model-value="cfg.senseGroups"
          class="chk-list"
          @change="(v) => (cfg.senseGroups = v as string[])"
        >
          <el-checkbox v-for="(_, gname) in draft.sense_groups" :key="gname" :value="gname as string">
            {{ gname }}
          </el-checkbox>
        </el-checkbox-group>
      </div>
    </article>
    <div class="add-row">
      <el-input v-model="newSubagentType" placeholder="新子 agent 类型名" @keydown.enter="addSubagent" />
      <button type="button" class="ghost-btn" @click="addSubagent">+ 新增</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
