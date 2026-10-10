import { reactive } from 'vue'
import type { InteractionRecord } from '@/application/backend/public'
import { questionsOf, type PanelQuestion } from './interactionPresentation'

export interface QuestionDraft {
  selectedLabels: string[]
  optionNotes: Record<string, string>
  freeText: string
  /** 各选项的补充输入是否展开：点「补充」tag 才展开，不随选中自动出现。 */
  notesOpen: Record<string, boolean>
  /** 「其他」选项项是否展开输入（自由文本输入框）；选中态 = otherOpen 或已有 freeText。 */
  otherOpen: boolean
}

/**
 * 提问草稿：模块级按 interactionId × questionId 隔离。
 * 列表模式与纸牌堆叠决策窗口共用同一份草稿，切换卡片/窗口不丢已答内容。
 */
const drafts = reactive<Record<string, Record<string, QuestionDraft>>>({})

export function draftOf(item: InteractionRecord, questionId: string): QuestionDraft {
  const group = (drafts[item.interactionId] ??= {})
  return (group[questionId] ??= {
    selectedLabels: [],
    optionNotes: {},
    freeText: '',
    notesOpen: {},
    otherOpen: false,
  })
}

/**
 * 选项选中切换：单选互斥、多选可叠加。
 * 所有已输入的补充内容（选项补充 optionNotes）一律保留，
 * 切换选中、取消选中、展开/收起、切题/切卡都不删除。
 * 单选互斥同时放弃「其他」选项项（收起输入框并清空自由文本），避免选项与补充回答并存冲突。
 */
export function toggleOption(
  item: InteractionRecord,
  questionId: string,
  label: string,
  multi: boolean,
): void {
  const draft = draftOf(item, questionId)
  if (!multi) {
    // 单选：点已选 → 清空（可取消）；未选 → 替换（清空其他补充，单选二选一）
    draft.selectedLabels = draft.selectedLabels.includes(label) ? [] : [label]
    if (draft.selectedLabels.includes(label)) {
      draft.otherOpen = false
      draft.freeText = ''
    }
  } else if (draft.selectedLabels.includes(label)) {
    draft.selectedLabels = draft.selectedLabels.filter((value) => value !== label)
  } else draft.selectedLabels.push(label)
}

/**
 * 「其他」选项项：作为单选/多选视觉一致的选项，点击展开自由文本输入框
 * （单选时同时取消其他选项选中；多选可与其他选项共存）。再次点击收起并清空自由文本。
 */
export function toggleOther(item: InteractionRecord, questionId: string): void {
  const draft = draftOf(item, questionId)
  if (draft.otherOpen) {
    draft.otherOpen = false
    draft.freeText = ''
    return
  }
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !question.multiSelect) draft.selectedLabels = []
  draft.otherOpen = true
}

/** 「其他」选项项的输入框展开态。 */
export function otherOpenOf(item: InteractionRecord, questionId: string): boolean {
  return draftOf(item, questionId).otherOpen
}

/** 选项内部末尾「补充」tag：选中选项不再自动展开补充输入，点击 tag 才展开（未选中时先选中）。 */
export function toggleNoteOpen(item: InteractionRecord, questionId: string, label: string): void {
  const draft = draftOf(item, questionId)
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !draft.selectedLabels.includes(label)) {
    toggleOption(item, questionId, label, question.multiSelect)
  }
  draft.notesOpen = { ...draft.notesOpen, [label]: !draft.notesOpen[label] }
}

export function noteOpenOf(item: InteractionRecord, questionId: string, label: string): boolean {
  return !!draftOf(item, questionId).notesOpen[label]
}

export function onOptionNoteInput(
  item: InteractionRecord,
  questionId: string,
  label: string,
  value: string,
): void {
  const draft = draftOf(item, questionId)
  draft.optionNotes = { ...draft.optionNotes, [label]: value }
}

/** 「其他补充」输入框获得焦点：单选模式立即取消已选选项（不必等到输入内容）。 */
export function onOtherFocus(item: InteractionRecord, questionId: string): void {
  const draft = draftOf(item, questionId)
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !question.multiSelect) {
    draft.selectedLabels = []
  }
}

/** 「其他补充」输入：单选模式下输入即取消选项选中（互斥选中态），已输入内容一律保留。 */
export function onOtherInput(item: InteractionRecord, questionId: string, value: string): void {
  const draft = draftOf(item, questionId)
  draft.freeText = value
  if (value) draft.otherOpen = true
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !question.multiSelect && draft.freeText.trim()) {
    draft.selectedLabels = []
  }
}

/** 单题完成度判定（底部「已完成 x/y 题」与提交前置禁用共用）。 */
export function questionAnswered(item: InteractionRecord, question: PanelQuestion): boolean {
  const draft = draftOf(item, question.questionId)
  if (question.options.length === 0) return !!draft.freeText.trim()
  if (question.multiSelect) return draft.selectedLabels.length > 0 || !!draft.freeText.trim()
  return draft.selectedLabels.length === 1 || !!draft.freeText.trim()
}

export function answeredCountOf(item: InteractionRecord): number {
  return questionsOf(item).filter((question) => questionAnswered(item, question)).length
}

export function allAnsweredOf(item: InteractionRecord): boolean {
  const questions = questionsOf(item)
  return questions.length > 0 && questions.every((question) => questionAnswered(item, question))
}
