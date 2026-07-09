<script setup lang="ts">
/**
 * BrainsTab：AI 大脑（llm.brain）配置。
 * 每颗 brain 一张名片；provider 决定方言；key 建议 $ENV 走 .env。
 * 改名 = 删旧 key 加新 key（保序重建）+ 迁移 default/subagents 引用；复制生成 _copy 副本并进入命名态。
 * 删除走 ConfirmPopover 二次确认（删大脑会让引用它的默认宠物/子 agent 启动失败）。
 */
import { ref } from "vue";
import { Check, Close, CopyDocument, Delete } from "@element-plus/icons-vue";
import type { ConfigDto } from "@/services/agentApi";
import { PROVIDERS } from "../constants";
import ConfirmPopover from "../ConfirmPopover.vue";

const props = defineProps<{ draft: ConfigDto }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

const newBrainName = ref("");
const editingName = ref<string | null>(null);
const editValue = ref("");
const vFocus = { mounted: (el: HTMLElement) => el.querySelector("input")?.focus() };

function addBrain(): void {
  const name = newBrainName.value.trim();
  if (!name) return;
  if (props.draft.llm.brain[name]) {
    emit("error", `大脑 "${name}" 已存在`);
    return;
  }
  props.draft.llm.brain[name] = { model: "", provider: "openai", contextLimit: 8192 };
  newBrainName.value = "";
}
function removeBrain(name: string): void {
  delete props.draft.llm.brain[name];
}
function startRenameBrain(name: string): void {
  editingName.value = name;
  editValue.value = name;
  emit("error", "");
}
function cancelRenameBrain(): void {
  editingName.value = null;
  editValue.value = "";
}
function commitBrainName(oldName: string): void {
  const newName = editValue.value.trim();
  if (!newName || newName === oldName) {
    editingName.value = null;
    return;
  }
  if (props.draft.llm.brain[newName]) {
    emit("error", `大脑 "${newName}" 已存在`);
    return; // 保持编辑态
  }
  const cfg = props.draft.llm.brain[oldName];
  // 重建对象保持原顺序（不能 delete+add，否则新 key 跳到末尾）
  const brains = props.draft.llm.brain;
  const rebuilt = {} as typeof brains;
  for (const [k, v] of Object.entries(brains)) {
    if (k === oldName) rebuilt[newName] = cfg;
    else rebuilt[k] = v;
  }
  props.draft.llm.brain = rebuilt;
  // 迁移引用，避免 default/subagents 指向已改名 brain 触发校验失败
  if (props.draft.default?.brain === oldName) props.draft.default.brain = newName;
  if (props.draft.subagents) {
    for (const sa of Object.values(props.draft.subagents)) {
      if (sa.brain === oldName) sa.brain = newName;
    }
  }
  editingName.value = null;
  emit("error", "");
}
function duplicateBrain(name: string): void {
  const src = props.draft.llm.brain[name];
  if (!src) return;
  let newName = `${name}_copy`;
  let i = 2;
  while (props.draft.llm.brain[newName]) newName = `${name}_copy_${i++}`;
  props.draft.llm.brain[newName] = structuredClone(src);
  // 进入新 card 命名态，用户可立即改名为所需名
  editingName.value = newName;
  editValue.value = newName;
  emit("error", "");
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">每颗 brain 一张「大脑名片」。provider 决定方言（openai/ollama/mock）；key 建议填 $ENV 走 .env，不明文。</p>
    <p class="warn-hint">⚠️ 删除大脑会让引用它的「默认宠物」「子 agent」启动失败。</p>
    <article v-for="(cfg, name, idx) in draft.llm.brain" :key="name" class="card">
      <header class="card-head">
        <span class="card-idx">{{ idx + 1 }}</span>
        <span class="card-title">
          <el-input
            v-if="editingName === name"
            v-focus
            v-model="editValue"
            class="card-name-input"
            size="small"
            @keydown.enter="commitBrainName(name as string)"
            @keydown.esc="cancelRenameBrain()"
          />
          <span v-else class="card-name editable" title="点击改名" @click="startRenameBrain(name as string)">{{ name }}</span>
        </span>
        <span class="card-actions">
          <template v-if="editingName === name">
            <button type="button" class="icon-btn ok" aria-label="确认改名" @click="commitBrainName(name as string)">
              <Check class="ico" />
            </button>
            <button type="button" class="icon-btn" aria-label="取消" @click="cancelRenameBrain()">
              <Close class="ico" />
            </button>
          </template>
          <template v-else>
            <button type="button" class="icon-btn" aria-label="复制" @click="duplicateBrain(name as string)">
              <CopyDocument class="ico" />
            </button>
            <ConfirmPopover :title="`确认删除大脑「${name}」？`" @confirm="removeBrain(name as string)">
              <template #trigger>
                <button type="button" class="icon-btn danger" aria-label="删除">
                  <Delete class="ico" />
                </button>
              </template>
            </ConfirmPopover>
          </template>
        </span>
      </header>
      <div class="card-grid">
        <label class="field">
          <span class="lbl">provider 适配器</span>
          <el-select v-model="cfg.provider">
            <el-option v-for="p in PROVIDERS" :key="p" :label="p" :value="p" />
          </el-select>
        </label>
        <label class="field">
          <span class="lbl">model 型号 *</span>
          <el-input v-model="cfg.model" placeholder="gpt-3.5-turbo" />
        </label>
        <label class="field">
          <span class="lbl">url 地址</span>
          <el-input v-model="cfg.url" placeholder="$OLLAMA_HOST 或 https://..." />
        </label>
        <label class="field">
          <span class="lbl">key 门禁卡</span>
          <el-input v-model="cfg.key" placeholder="$OPENAI_API_KEY" />
        </label>
        <label class="field">
          <span class="lbl">contextLimit 记忆容量</span>
          <el-input-number v-model="cfg.contextLimit" :controls="false" />
        </label>
        <label class="field">
          <span class="lbl">rpm 每分钟限额</span>
          <el-input-number v-model="cfg.rpm" :controls="false" placeholder="不限" />
        </label>
        <el-checkbox
          :model-value="cfg.thinking"
          @change="(v) => (cfg.thinking = v as boolean)"
        >thinking 会深思（推理模型设 true）</el-checkbox>
      </div>
    </article>
    <div class="add-row">
      <el-input v-model="newBrainName" placeholder="新大脑名" @keydown.enter="addBrain" />
      <button type="button" class="ghost-btn" @click="addBrain">+ 新增</button>
    </div>
  </section>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
