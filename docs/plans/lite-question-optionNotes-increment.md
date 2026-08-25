# LiteView.vue 提问渲染增量（fe-qa / t2 每选项补充描述）

> 用途：fe-lite 正在对 LiteView.vue 做结构性大改（t13-t16/t10：滚动条/节点点击/工具块/尺寸详情/composer）。
> 本文件记录 fe-qa 在 t2 中加入的「提问渲染」改动，键名/函数名定位，便于在最新文件上重放或核对，避免覆盖冲突。
> 说明：t2 该部分改动已应用并自测通过；若 fe-lite 重构覆盖了提问渲染，按本说明重放。

## 涉及文件

- web/src/features/lite/LiteView.vue（本说明）
- web/src/features/lite/liteStore.ts（LiteQuestionDraft 类型 + interactionDrafts 形状，见下）

## liteStore.ts 改动（非冲突，已定稿）

新增导出：

```ts
export interface LiteQuestionDraft {
  selected: string[]
  notes: Record<string, string>
  freeText: string
}
```

LiteRootUiState.interactionDrafts 类型：

```ts
// 旧：interactionDrafts: Record<string, Record<string, string[] | string>>
interactionDrafts: Record<string, Record<string, LiteQuestionDraft>>
```

## LiteView.vue 改动点（按定位键）

### 1) import（文件头）

```ts
import { useLiteStore, type LiteQuestionDraft } from './liteStore'
```

### 2) QuestionView.options 透传 description

旧：

```ts
interface QuestionView {
  questionId: string
  question: string
  options: Array<{ label: string }>
  multiSelect: boolean
  freeText: boolean
}
```

新（options 增加 description）：

```ts
interface QuestionView {
  questionId: string
  question: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
  freeText: boolean
}
```

questionsOf 内对应改：

```ts
options: Array.isArray(question.options)
  ? (question.options as Array<{ label: string; description?: string }>)
  : [],
```

### 3) questionDrafts setter 类型

旧：`set: (value: Record<string, Record<string, string[] | string>>) => ...`
新：`set: (value: Record<string, Record<string, LiteQuestionDraft>>) => ...`

### 4) 草稿助手函数（draftOf / selectedOf / noteOf / toggleOption / setOptionNote / textDraftOf / setTextDraft）

在 selectedOf 前新增 draftOf，并把各助手改为基于 LiteQuestionDraft：

```ts
function draftOf(batchId: string, questionId: string): LiteQuestionDraft {
  return questionDrafts.value[batchId]?.[questionId] ?? { selected: [], notes: {}, freeText: '' }
}
function selectedOf(batchId: string, questionId: string): string[] {
  return draftOf(batchId, questionId).selected
}
function noteOf(batchId: string, questionId: string, label: string): string {
  return draftOf(batchId, questionId).notes[label] ?? ''
}
function toggleOption(batchId: string, question: QuestionView, label: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const draft = draftOf(batchId, question.questionId)
  const current = new Set(draft.selected)
  const next = { ...draft }
  if (question.multiSelect) {
    if (current.has(label)) {
      current.delete(label)
      const { [label]: _removed, ...rest } = next.notes
      next.notes = rest
    } else current.add(label)
    next.selected = [...current]
  } else {
    next.selected = current.has(label) ? [] : [label]
    // 单选切选项：丢弃非当前选项的补充描述
    next.notes = current.has(label)
      ? {}
      : { ...(next.notes[label] ? { [label]: next.notes[label] } : {}) }
  }
  batch[question.questionId] = next
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
function setOptionNote(batchId: string, questionId: string, label: string, value: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const draft = draftOf(batchId, questionId)
  batch[questionId] = { ...draft, notes: { ...draft.notes, [label]: value } }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
function textDraftOf(batchId: string, questionId: string): string {
  return draftOf(batchId, questionId).freeText
}
function setTextDraft(batchId: string, questionId: string, value: string): void {
  const batch = { ...questionDrafts.value[batchId] }
  const draft = draftOf(batchId, questionId)
  batch[questionId] = { ...draft, freeText: value }
  questionDrafts.value = { ...questionDrafts.value, [batchId]: batch }
}
```

### 5) onAnswerBatch：提交时收集 optionNotes

```ts
async function onAnswerBatch(interaction: LiteInteraction): Promise<void> {
  const batchId = interaction.interactionId
  const answers = questionsOf(interaction).map((question) => {
    const draft = draftOf(batchId, question.questionId)
    if (question.freeText) {
      return { questionId: question.questionId, freeText: draft.freeText }
    }
    const notes: Record<string, string> = {}
    for (const label of draft.selected) {
      const note = draft.notes[label]?.trim()
      if (note) notes[label] = note
    }
    return {
      questionId: question.questionId,
      selectedLabels: draft.selected,
      ...(Object.keys(notes).length ? { optionNotes: notes } : {}),
    }
  })
  // ... 原有 answering / lite.answerQuestion 逻辑不变
}
```

### 6) 模板：选项块（提问渲染，未选中显示 label + description；选中展开补充描述 textarea）

旧（选项直接是 label 单层）：

```html
<template v-if="!question.freeText">
  <label v-for="option in question.options" :key="option.label" class="lite-option">
    <input ... :checked="selectedOf(...).includes(option.label)" @change="toggleOption(...)" />
    <span>{{ option.label }}</span>
  </label>
</template>
```

新：

```html
<template v-if="!question.freeText">
  <div v-for="option in question.options" :key="option.label" class="lite-option-wrap">
    <label class="lite-option">
      <input
        :type="question.multiSelect ? 'checkbox' : 'radio'"
        :name="activeInteraction.interactionId + ':' + question.questionId"
        :disabled="!interactionActionable(activeInteraction)"
        :checked="selectedOf(activeInteraction.interactionId, question.questionId).includes(option.label)"
        @change="toggleOption(activeInteraction.interactionId, question, option.label)"
      />
      <span class="lite-option-label">{{ option.label }}</span>
      <span v-if="option.description" class="lite-option-description">{{ option.description }}</span>
    </label>
    <textarea
      v-if="selectedOf(activeInteraction.interactionId, question.questionId).includes(option.label)"
      class="lite-option-note"
      rows="2"
      :value="noteOf(activeInteraction.interactionId, question.questionId, option.label)"
      :disabled="!interactionActionable(activeInteraction)"
      placeholder="为这个选项补充描述（可选）"
      @input="setOptionNote(activeInteraction.interactionId, question.questionId, option.label, ($event.target as HTMLTextAreaElement).value)"
    />
  </div>
</template>
```

### 7) CSS（新增，不影响瀑布流/tab 结构）

```css
.lite-option-wrap { display: flex; flex-direction: column; gap: 4px; }
.lite-option-label { min-width: 0; flex: 0 0 auto; }
.lite-option-description {
  min-width: 0; flex: 1 1 auto; color: var(--el-text-color-secondary);
  font-size: 11px; line-height: 1.4;
}
.lite-option-note {
  width: 100%; box-sizing: border-box; padding: 5px 8px;
  border: 1px solid var(--el-border-color); border-radius: 5px;
  background: var(--el-fill-color-blank); color: inherit; resize: vertical;
}
```

## 范围边界（勿越界）

- 只涉及 questionsOf/QuestionView/草稿助手/onAnswerBatch/提问选项模板/CSS。
- 不触碰 .lite-pending-tabs 结构、瀑布流渲染、滚动条、节点交互、composer。
- 若与 fe-lite 改动冲突以合作为主：以最新文件为准，按本说明重放 t2 增量。

## 验证

- cd web && npx vitest run test/lite 34/34 通过
- pnpm type-check / pnpm web:type-check 0 错
