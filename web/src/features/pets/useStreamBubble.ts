import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { StreamState } from "@/stores";
import { renderMarkdown } from "@/utils/markdown";
import type { PetInstance } from "./types";

/**
 * PetSprite 工作气泡 composable：双气泡显隐 + retainUntil 保留 + 流式 auto-scroll。
 *
 * thinking 阶段（thinking 非空 && content 空）：主气泡全空间显 thinking（主 pet 多行流式；子 pet 单行 hover 展开）。
 * thinking 结束（content 非空）：主气泡显 content（md）；thinking 收成 content 气泡左下角按钮，hover 弹气泡显完整内容。
 * done 后 content/thinking 保留 20s（retainUntil）；工作气泡自身 hover 期间保持。
 *
 * 气泡显隐门控仅收 bubbleHover（工作气泡自身 hover，本 composable 自管）——
 * retainUntil 过期后悬浮 pet 身体不复现历史气泡（petHover 不参与门控，仅供 usePetStyles）。
 */

/** composable 所需 props 子集（PetSprite props 的 pet + stream）。 */
export interface StreamBubbleProps {
  pet: PetInstance;
  stream?: StreamState;
}

export function useStreamBubble(props: StreamBubbleProps) {
  // hover 保持：工作气泡自身 hover 期间，即使 retainUntil 过期也保持显示。
  // pet 身体 hover 不在此门控（不复现历史气泡）。
  const bubbleHover = ref(false);

  // retainUntil 过期检测：nowTick 每秒刷新驱动 done 后保留期到期重渲染。
  const nowTick = ref(Date.now());
  let retainTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);

  // === 工作气泡状态 ===
  // thinking 阶段（thinking 非空 && content 空）：主气泡全空间显 thinking（主 pet 多行；子 pet 单行 hover 展开）
  // thinking 结束（content 非空）：主气泡显 content（md）；thinking 收成 content 气泡左下角按钮，hover 弹气泡显完整内容
  // done 后 content/thinking 保留 20s（retainUntil）；hover 期间保持。
  const hasStreamContent = computed(
    () => !!props.stream && (!!props.stream.thinking || !!props.stream.content),
  );
  const retainActive = computed(
    () => !!props.stream?.retainUntil && props.stream.retainUntil > nowTick.value,
  );
  const hasStream = computed(
    () =>
      !props.pet.isGhost &&
      hasStreamContent.value &&
      (!!props.pet.isWorking || retainActive.value || bubbleHover.value),
  );
  // === busy-indicator 状态（与气泡显示解耦；语义对齐"还在做事"） ===
  // 不含 hover / retainUntil：hover 仅保持气泡显示；retain 期不视为"还在做事"。
  // C 方案：isWorking || runningTools.length > 0 || approval != null || questionBatches 非空
  const hasPendingQuestion = computed(() => (props.stream?.questionBatches.length ?? 0) > 0);
  const isBusy = computed(
    () =>
      !props.pet.isGhost &&
      (!!props.pet.isWorking ||
        (props.stream?.runningTools?.length ?? 0) > 0 ||
        !!props.stream?.approval ||
        hasPendingQuestion.value),
  );
  const hasContent = computed(() => !!props.stream?.content);
  const thinkingOnly = computed(() => !!props.stream?.thinking && !props.stream?.content);
  const showWorkMain = computed(() => hasStream.value && (thinkingOnly.value || hasContent.value));
  // thinking 按钮：思考结束（有 content）且有 thinking 时，content 气泡左下角显按钮，hover 弹气泡。
  // approval/question 走独立气泡（v-else-if 链，work-main 不与之同显），此处无需抑制条件。
  const showThinkingButton = computed(
    () => hasStream.value && hasContent.value && !!props.stream?.thinking,
  );
  // 显示单次响应全部内容（不截取）
  const displayThinking = computed(() => props.stream?.thinking ?? "");
  const displayContent = computed(() => props.stream?.content ?? "");
  const renderedContent = computed(() => renderMarkdown(displayContent.value));

  // === 流式滚动保持底部 ===
  const workTextRef = ref<HTMLElement | null>(null);
  const userScrolledUp = ref(false);
  // 新流开始（thinking/content 从空变非空）-> 重置 userScrolledUp
  watch(
    () => props.stream?.thinking ?? "",
    (v, prev) => {
      if (v && !prev) userScrolledUp.value = false;
    },
  );
  watch(
    () => props.stream?.content ?? "",
    (v, prev) => {
      if (v && !prev) userScrolledUp.value = false;
    },
  );
  // 流式追加 -> 自动滚到底部（用户手动上滚时暂停）
  watch(
    () => [props.stream?.thinking, props.stream?.content],
    () => {
      if (userScrolledUp.value) return;
      nextTick(() => {
        const el = workTextRef.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },
  );
  function onWorkTextScroll(): void {
    const el = workTextRef.value;
    if (!el) return;
    // 距底部 >20px 视为用户主动上滚
    userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > 20;
  }

  function onBubbleEnter(): void {
    bubbleHover.value = true;
  }
  function onBubbleLeave(): void {
    bubbleHover.value = false;
  }

  onBeforeUnmount(() => {
    if (retainTimer !== undefined) clearInterval(retainTimer);
  });

  return {
    hasStream,
    isBusy,
    showWorkMain,
    showThinkingButton,
    thinkingOnly,
    hasContent,
    displayThinking,
    displayContent,
    renderedContent,
    workTextRef,
    onWorkTextScroll,
    onBubbleEnter,
    onBubbleLeave,
  };
}
