import { computed } from "vue";
import type { Ref } from "vue";
import type { StreamState } from "@/stores";
import { useAgentsStore } from "@/stores";
import { faceMotion, ghostFaceMotion, ghostSpriteMotion, handMotion, speechMotion, spriteMotion } from "./petMotion";
import type { PetInstance } from "./types";

/**
 * PetSprite 视觉计算 composable：所有 computed style / motion config / 辅助函数。
 * 输入 pet + stream + petHover，输出 PetBody / PetBubbles / orchestrator 所需的全部视觉数据。
 */

/** tribe → 色相：子 pet name 部落色区分（主 pet name 保持 --pet-color 高亮） */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

/**
 * pet 身体 z-index：拖拽最高；否则 hasSpeech 加成（子有气泡主无时子>主，主子都有时主>子）。
 * 气泡独立 z-index（speechZIndex）整体高于身体——因 .pet-wrap 不创建 stacking context。
 *
 * CP5 扩展：审批气泡 z-index 单独提升到 APPROVAL_Z_INDEX=400，高于 AgentDialog 300 / HistoryDrawer 280 / FAB 200。
 */
export function petBodyZIndex(pet: PetInstance, hovered: boolean): number {
  if (pet.action === "dragging") return 20;
  if (hovered) return 15;
  return (pet.speech ? 10 : 0) + (pet.isMaster ? 2 : 1);
}

export function speechZIndex(pet: PetInstance): number {
  if (pet.action === "dragging") return 120;
  return 100 + (pet.isMaster ? 2 : 1);
}

/** 审批气泡专属 z-index：固定 400。 */
export const APPROVAL_Z_INDEX = 400;

/** 气泡锚点：气泡底部贴 status-row 上方 16px。offset=28（44-16）。 */
const BUBBLE_OFFSET_Y = 28;

export function usePetStyles(
  pet: () => PetInstance,
  stream: () => StreamState | undefined,
  petHover: Ref<boolean>,
  paused: () => boolean,
) {
  const agents = useAgentsStore();

  // === 表情 / 手部 / 名字 ===
  const faceGlyph = computed(() => (pet().isGhost ? pet().ghostFace ?? "👻" : pet().face[pet().mood]));
  const leftHand = computed(() => pet().hands[pet().mood].left);
  const rightHand = computed(() => pet().hands[pet().mood].right);
  const nameChars = computed(() => Array.from(pet().name));

  // === motion configs ===
  const sprite = computed(() => (pet().isGhost ? ghostSpriteMotion() : spriteMotion(pet().action)));
  const face = computed(() => (pet().isGhost ? ghostFaceMotion() : faceMotion(pet().mood)));
  const leftHandMotion = computed(() => handMotion(pet().action, "left"));
  const rightHandMotion = computed(() => handMotion(pet().action, "right"));
  const speech = speechMotion();

  // thinking 侧气泡 motion：与 speechMotion 同构（opacity+scale 进退），顶部齐平主气泡
  const workSideMotion = {
    initial: { opacity: 0, scale: 0.86, x: "-100%", y: "-100%" },
    animate: { opacity: 1, scale: 1, x: "-100%", y: "-100%" },
    exit: { opacity: 0, scale: 0.86, x: "-100%", y: "-100%" },
    transition: { duration: 0.18, ease: "easeOut" as const },
  };

  // === style computeds ===
  const style = computed(() => ({
    transform: `translate3d(${pet().x}px, ${pet().y}px, 0)`,
    zIndex: String(petBodyZIndex(pet(), petHover.value)),
    "--pet-color": pet().color,
    "--pet-accent": pet().accent,
    "--pet-direction": String(pet().direction),
    "--pet-scale": pet().isGhost ? "0.7" : pet().isMaster ? "1" : "0.75",
    "--tribe-hue": `${hashHue(pet().tribe)}deg`,
  }));

  const speechStyle = computed(() => ({
    left: `${pet().x + pet().width / 2}px`,
    top: `${pet().y + BUBBLE_OFFSET_Y}px`,
    zIndex: String(speechZIndex(pet())),
  }));

  const sideBubbleStyle = computed(() => ({
    left: `${pet().x - 60}px`,
    top: `${pet().y + BUBBLE_OFFSET_Y}px`,
    zIndex: String(speechZIndex(pet())),
  }));

  const approvalStyle = computed(() => ({
    left: `${pet().x + pet().width / 2}px`,
    top: `${pet().y + BUBBLE_OFFSET_Y}px`,
    zIndex: String(APPROVAL_Z_INDEX),
  }));

  const runningTools = computed(() => stream()?.runningTools ?? []);

  const todoEnabled = computed(
    () =>
      !pet().isGhost &&
      agents.senseGroupsHasSense(pet().runtime?.senseGroup, "update_todo"),
  );
  const hasTodoData = computed(() => {
    const h = stream()?.history;
    return !!h && h.some((it) => it.senseCalls?.some((c) => c.name === "update_todo"));
  });
  const todoPanelStyle = computed(() => ({
    position: "absolute" as const,
    left: `${pet().x + pet().width + 8}px`,
    top: `${pet().y + BUBBLE_OFFSET_Y}px`,
    zIndex: String(speechZIndex(pet())),
  }));

  const petIconsStyle = computed(() => ({
    position: "absolute" as const,
    left: `${pet().x + pet().width}px`,
    top: `${pet().y + 16}px`,
    zIndex: String(speechZIndex(pet()) - 1),
  }));

  const classes = computed(() => [
    `is-${pet().action}`,
    `mood-${pet().mood}`,
    {
      "is-master": pet().isMaster,
      "is-sub": !pet().isMaster,
      "is-ghost": pet().isGhost,
      "is-paused": paused(),
    },
  ]);

  return {
    faceGlyph,
    leftHand,
    rightHand,
    nameChars,
    sprite,
    face,
    leftHandMotion,
    rightHandMotion,
    speech,
    workSideMotion,
    style,
    speechStyle,
    sideBubbleStyle,
    approvalStyle,
    runningTools,
    todoEnabled,
    hasTodoData,
    todoPanelStyle,
    petIconsStyle,
    classes,
  };
}
