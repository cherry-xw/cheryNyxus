import { ref } from "vue";

/** UI 焦点 / 面板开关 / 滚动触发——独立于数据层的纯 UI 状态。 */
export function createUiState() {
  const activeDialogChatId = ref<string | null>(null);
  const activeHistoryChatId = ref<string | null>(null);
  const historyListOpen = ref(false);
  const settingsOpen = ref(false);
  const pendingScrollSenseCallId = ref<string | null>(null);
  return { activeDialogChatId, activeHistoryChatId, historyListOpen, settingsOpen, pendingScrollSenseCallId };
}
