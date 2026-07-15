<script setup lang="ts">
import type { QuestionItemState, RunningTool } from "@/stores/agents";
import { useAgentsStore } from "@/stores";

const props = defineProps<{
  tools: RunningTool[];
  questions: QuestionItemState[];
  chatId: string;
}>();
const agents = useAgentsStore();

function isDrafted(question: QuestionItemState): boolean {
  return question.localStatus === "pending" && Boolean(
    question.draftAnswer?.selectedLabels.length ||
    question.draftAnswer?.freeText?.trim() ||
    question.draftAnswer?.cancelled,
  );
}
</script>

<template>
  <div v-if="tools.length || questions.length" class="running-tools" aria-label="运行中工具">
    <el-tooltip
      v-for="question in questions"
      :key="question.questionId"
      :content="question.header ?? question.question"
      placement="top"
      :show-after="120"
    >
      <button
        type="button"
        class="run-icon is-clickable"
        :class="{
          'is-question': question.localStatus === 'pending' && !isDrafted(question),
          'is-question-draft': isDrafted(question),
          'is-question-done': question.localStatus === 'ready',
        }"
        :aria-label="question.header ?? question.question"
        @click="agents.selectQuestion(chatId, question.questionId)"
      >{{ question.localStatus === "ready" ? "👌" : "✍️" }}</button>
    </el-tooltip>
    <span
      v-for="tool in tools"
      :key="tool.id"
      class="run-icon"
      :title="tool.name"
    >{{ agents.iconForTool(tool.name) }}</span>
  </div>
</template>

<style scoped lang="less">
@glyph-fonts: ui-rounded, "Hiragino Sans", "PingFang SC", "Noto Sans Symbols 2",
  "Noto Sans Symbols", "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", sans-serif;

.running-tools {
  display: inline-flex;
  align-items: center;
  gap: 1px;
}

.run-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 5px;
  background: rgba(255, 196, 87, 0.4);
  font-family: @glyph-fonts;
  line-height: 1;
  font-size: 11px;
  animation: run-pulse 1.1s ease-in-out infinite;

  &.is-clickable { cursor: pointer; }
  &.is-question {
    background: rgba(124, 58, 237, 0.2);
    border-color: rgba(124, 58, 237, 0.4);
  }
  &.is-question-draft {
    background: rgba(37, 99, 235, 0.2);
    border-color: rgba(37, 99, 235, 0.45);
    animation: none;
  }
  &.is-question-done {
    background: rgba(74, 222, 128, 0.4);
    border-color: rgba(74, 222, 128, 0.5);
    animation: none;
  }
}

@keyframes run-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
</style>
