import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Ref } from "vue";
import type { StreamState } from "@/stores";
import { renderMarkdown } from "@/utils/markdown";
import type { PetInstance } from "./types";

/**
 * PetSprite 工作气泡 composable：双气泡显隐 + retainUntil 保留 + 流式 auto-scroll。
 *
 * thinking 阶段（thinking 非空 && content 空）：主气泡全空间显 thinking。
 * thinking 结束（content 非空）：主气泡显 content（md）；thinking 移至左侧同尺寸浅色气泡（顶部齐平）。
 * done 后 content/thinking 保留 20s（retainUntil）；hover 期间保持。
 *
 * isHovered = petHover（身体，来自 usePetDrag）|| bubbleHover（工作气泡，本 composable 自管）。
 * 行为与原 PetSprite 内联实现一致，仅下沉抽取。
 */

/** composable 所需 props 子集（PetSprite props 的 pet + stream）。 */
export interface StreamBubbleProps {
  pet: PetInstance;
  stream?: StreamState;
}

export function useStreamBubble(props: StreamBubbleProps, petHover: Ref<boolean>) {
  // hover 保持：pet 身体或工作气泡 hover 期间，即使 retainUntil 过期也保持显示。
  const bubbleHover = ref(false);
  const isHovered = computed(() => petHover.value || bubbleHover.value);

  // retainUntil 过期检测：nowTick 每秒刷新驱动 done 后保留期到期重渲染。
  const nowTick = ref(Date.now());
  let retainTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);

  // === 工作气泡（双气泡）状态 ===
  // thinking 阶段（thinking 非空 && content 空）：主气泡全空间显 thinking
  // thinking 结束（content 非空）：主气泡显 content（md）；thinking 移至左侧同尺寸浅色气泡（顶部齐平）
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
      (!!props.pet.isWorking || retainActive.value || isHovered.value),
  );
  // === busy-indicator 状态（与气泡显示解耦；语义对齐"还在做事"） ===
  // 不含 hover / retainUntil：hover 仅保持气泡显示；retain 期不视为"还在做事"。
  // C 方案：isWorking || runningTools.length > 0 || approval != null
  const isBusy = computed(
    () =>
      !props.pet.isGhost &&
      (!!props.pet.isWorking ||
        (props.stream?.runningTools?.length ?? 0) > 0 ||
        !!props.stream?.approval),
  );
  const hasContent = computed(() => !!props.stream?.content);
  const thinkingOnly = computed(() => !!props.stream?.thinking && !props.stream?.content);
  const showWorkMain = computed(() => hasStream.value && (thinkingOnly.value || hasContent.value));
  const showWorkSide = computed(
    () =>
      // 审批存在时优先显 ApprovalCard，抑制侧气泡（避免与 interrupt 视觉冲突）
      !props.stream?.approval &&
      hasStream.value &&
      hasContent.value &&
      !!props.stream?.thinking,
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
    showWorkSide,
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
