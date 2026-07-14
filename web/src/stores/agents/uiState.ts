import { computed, ref, type ComputedRef } from "vue";

/** 历史抽屉栈最大深度（防多级 spawn 递归下钻失控）。 */
const HISTORY_STACK_MAX = 5;

/** UI 焦点 / 面板开关 / 滚动触发——独立于数据层的纯 UI 状态。 */
export function createUiState() {
  const activeDialogChatId = ref<string | null>(null);
  // 历史抽屉栈：chatId 数组，栈底=根抽屉，栈顶=当前可见层。空=无抽屉。
  // spawn 多级下钻逐层 push（盖在上层之上）；ESC/遮罩/✕ 仅 pop 栈顶（逐层返回）。
  const historyDrawerStack = ref<string[]>([]);
  const historyListOpen = ref(false);
  const settingsOpen = ref(false);
  const pendingScrollSenseCallId = ref<string | null>(null);

  /** 栈顶 chatId（无抽屉时 null）。供仅需“当前焦点”的旧调用方读。 */
  const topHistoryChatId: ComputedRef<string | null> = computed(() => {
    const stack = historyDrawerStack.value;
    return stack.length > 0 ? (stack[stack.length - 1] ?? null) : null;
  });

  /** 打开根抽屉（PetStage 从 pet 列表打开）：重置栈为单元素（新浏览会话，不叠加旧栈）。 */
  function openHistoryRoot(chatId: string): void {
    historyDrawerStack.value = [chatId];
  }

  /** 下钻子 chat（SpawnRenderer「详情」）：push 栈顶。无抽屉 / 栈顶已是该 id / 超上限则忽略。 */
  function drillHistoryChild(chatId: string): void {
    const stack = historyDrawerStack.value;
    if (stack.length === 0) return; // 无抽屉（下钻必在抽屉内触发，理论不达）
    if (stack[stack.length - 1] === chatId) return; // 防重复
    if (stack.length >= HISTORY_STACK_MAX) {
      console.warn(`[uiState] drillHistoryChild: 栈已达上限 ${HISTORY_STACK_MAX}，忽略下钻 ${chatId}`);
      return;
    }
    stack.push(chatId);
  }

  /** 关闭栈顶（✕ / 遮罩 / ESC）：逐层返回。 */
  function closeHistoryTop(): void {
    historyDrawerStack.value.pop();
  }

  /** 关闭全部抽屉。 */
  function closeAllHistory(): void {
    historyDrawerStack.value = [];
  }

  /** 清理被删除的 chat（removePetsByIds）：从栈中移除所有命中项。 */
  function pruneHistoryStack(removeIds: string[]): void {
    if (removeIds.length === 0) return;
    const set = new Set(removeIds);
    historyDrawerStack.value = historyDrawerStack.value.filter((id) => !set.has(id));
  }

  return {
    activeDialogChatId,
    historyDrawerStack,
    topHistoryChatId,
    openHistoryRoot,
    drillHistoryChild,
    closeHistoryTop,
    closeAllHistory,
    pruneHistoryStack,
    historyListOpen,
    settingsOpen,
    pendingScrollSenseCallId,
  };
}
