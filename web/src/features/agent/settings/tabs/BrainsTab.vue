<script setup lang="ts">
/**
 * BrainsTab：AI 大脑（llm.brain）配置入口。
 * 每颗 brain 一张 BrainCard；本组件只负责外壳（hint/warning）+ 媒体服务卡 + 新增行。
 * 改名/复制/删除/能力矩阵等 per-brain 逻辑已下沉到 BrainCard / MediaCapabilityGrid。
 */
import { ref } from "vue";
import type { ConfigDto } from "@/services/agentApi";
import BrainCard from "./BrainCard.vue";

const props = defineProps<{ draft: ConfigDto }>();
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

function mediaService(kind: "image" | "video" | "audio") {
  const media = (props.draft.media ??= {});
  return (media[kind] ??= { url: "", enabled: false });
}
</script>

<template>
  <section class="sect">
    <p class="sect-hint">每颗 brain 一张「大脑名片」。provider 决定方言（openai/ollama/mock）；key 建议填 $ENV 走 .env，不明文。</p>
    <p class="warn-hint">⚠️ 删除大脑会让引用它的「默认宠物」「角色」启动失败。</p>
    <BrainCard
      v-for="(cfg, name, idx) in draft.llm.brain"
      :key="name"
      :name="name as string"
      :idx="idx"
      :cfg="cfg"
      :draft="draft"
      @error="onError"
    />
    <article class="card media-card">
      <header class="media-card-head">
        <div><strong>媒体服务</strong><p class="hint">独立网关用于媒体理解、生成与编辑。</p></div>
        <label class="field upload-limit"><span class="lbl">上传上限（MiB）</span><el-input-number v-model="(draft.media ??= {}).maxUploadMb" :min="1" :controls="false" placeholder="100" /></label>
      </header>
      <div class="media-service-grid">
        <section v-for="kind in ['image', 'video', 'audio'] as const" :key="kind" class="media-service-card" :class="{ enabled: mediaService(kind).enabled }">
          <div class="media-service-title">
            <strong>{{ kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频' }}服务</strong>
            <el-switch v-model="mediaService(kind).enabled" />
          </div>
          <label class="field"><span class="lbl">网关地址</span><el-input v-model="mediaService(kind).url" class="mono-input" placeholder="https://media-gateway/..." /></label>
          <div class="media-service-fields">
            <label class="field"><span class="lbl">模型</span><el-input v-model="mediaService(kind).model" placeholder="可选" /></label>
            <label class="field"><span class="lbl">密钥</span><el-input v-model="mediaService(kind).key" class="mono-input" placeholder="可选" show-password /></label>
          </div>
        </section>
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

.media-card { gap: 12px; }

.media-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;

  strong { color: rgba(20, 22, 26, 0.84); font-size: 13px; }
  .hint { margin: 3px 0 0; }
}

.upload-limit { width: 132px; flex: none; }

.media-service-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.media-service-card {
  display: grid;
  gap: 8px;
  padding: 9px;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.5);

  &.enabled { border-color: rgba(190, 132, 28, 0.32); background: rgba(246, 183, 60, 0.07); }
}

.media-service-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; color: rgba(20, 22, 26, 0.75); font-size: 12px; }

.media-service-fields { display: grid; gap: 6px; }

@media (max-width: 560px) {
  .media-service-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .upload-limit { width: 128px; }
}
</style>
