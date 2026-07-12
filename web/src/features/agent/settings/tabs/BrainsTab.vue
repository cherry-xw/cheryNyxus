<script setup lang="ts">
/**
 * BrainsTab：AI 大脑（llm.brain）配置入口。
 * 每颗 brain 一张 BrainCard；本组件只负责外壳（hint/warning）+ 新增行。
 * 改名/复制/删除/能力矩阵等 per-brain 逻辑已下沉到 BrainCard。
 * 媒体服务已独立为 MediaTab。
 */
import { ref, computed } from "vue";
import type { ConfigDto } from "@/services/agentApi";
import BrainCard from "./BrainCard.vue";
import TabShell, { type IndexItem } from "../components/TabShell.vue";

const props = defineProps<{ draft: ConfigDto; envVars: string[] }>();
const emit = defineEmits<{ (e: "error", msg: string): void }>();

const newBrainName = ref("");

function onError(msg: string): void {
  emit("error", msg);
}

function addBrain(): void {
  const name = newBrainName.value.trim();
  if (!name) return;
  if (props.draft.llm.brain[name]) {
    emit("error", `大脑 "${name}" 已存在`);
    return;
  }
  props.draft.llm.brain[name] = { model: "", provider: "openai", contextLimit: 128000 };
  newBrainName.value = "";
}

/** 序号按钮列表：N 颗大脑。 */
const indexItems = computed<IndexItem[]>(() => {
  const items: IndexItem[] = [];
  for (const [name, cfg] of Object.entries(props.draft.llm.brain)) {
    items.push({
      label: name,
      kind: "brain",
      provider: cfg.provider ?? "",
      model: cfg.model ?? "",
      contextLimit: cfg.contextLimit,
    });
  }
  return items;
});
</script>

<template>
  <TabShell :index-items="indexItems">
    <template #hints>
      <p class="sect-hint">每颗 brain 一张「大脑名片」。provider 决定方言（openai/ollama/mock）；key 建议填 $ENV 走 .env，不明文。</p>
      <p class="warn-hint">⚠️ 删除大脑会让引用它的「默认宠物」「角色」启动失败。</p>
    </template>
    <template #popper="{ item }">
      <div class="index-card">
        <div class="index-card-title">{{ item.label as string }}</div>
        <div class="index-card-line"><b>provider</b><span>{{ (item.provider as string) || '—' }}</span></div>
        <div class="index-card-line"><b>model</b><span>{{ (item.model as string) || '—' }}</span></div>
        <div class="index-card-line"><b>ctx</b><span>{{ item.contextLimit ? `${item.contextLimit} tok` : '—' }}</span></div>
      </div>
    </template>
    <BrainCard
      v-for="(cfg, name, idx) in draft.llm.brain"
      :key="name"
      :name="name as string"
      :idx="idx"
      :cfg="cfg"
      :draft="draft"
      :env-vars="envVars"
      :data-anchor="idx"
      @error="onError"
    />
    <div class="add-row">
      <el-input v-model="newBrainName" placeholder="新大脑名" @keydown.enter="addBrain" />
      <button type="button" class="ghost-btn" @click="addBrain">+ 新增</button>
    </div>
  </TabShell>
</template>

<style scoped lang="less">
@import "../shared.less";
</style>
