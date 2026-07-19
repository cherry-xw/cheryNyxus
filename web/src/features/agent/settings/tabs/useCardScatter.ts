import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { SETTINGS_ACTIVE_TAB_KEY } from "../constants";

/**
 * useCardScatter：GlobalTab 散落浮动玻璃卡片的布局 + 拖拽 + 置顶 + 入场动画。
 *
 * 设计要点（见 plans/1-2-floating-willow.md §7）：
 *  - 锚点（anchor）键控的散落表，百分比 + 静态旋转，pinwheel 式部分重叠。
 *  - Pointer Events 拖拽；惰性 setPointerCapture（移动超阈值才捕获，保护卡内 el-input 选文）。
 *  - pointerdown 即 raise（含左下数字标冒泡）；topZ 单调递增；BASE_Z=10 避开 hover/modal 层。
 *  - SHIELD_PX=8 内缩 clamp，配合 canvas padding:6px + shell-scroll overflow:hidden 防 box-shadow 裁切。
 *  - ready flag：布局成功后不再重算，避免覆盖用户拖拽。
 *  - 坠落入场动画：每次进入 global tab（activeTab === 'global'）触发；prefers-reduced-motion 跳过。
 *
 * v-show 切换 tab 时组件不卸载，clientWidth 在隐藏时为 0 → 三重兜底：
 *  onMounted nextTick(layout) / ResizeObserver(layout) / watch(activeTab → nextTick(layout))。
 *  SettingsDialog 整体 v-if 卸载重建 → 每次重开弹窗即重算 → 天然「每次打开重置散落」。
 */

/** GlobalTab 7 张卡的 anchor 键（与 data-anchor 对齐）。 */
export type GlobalCardAnchor =
  | "default"
  | "editor"
  | "limits"
  | "logger"
  | "compression"
  | "memory-global"
  | "memory-workspace";

/** 散落表项：x/y 为画布内容盒的百分比；r 为静态旋转角度。 */
interface ScatterEntry {
  x: number;
  y: number;
  r: number;
}

/**
 * Pinwheel 散落表：故意部分重叠以呈现玻璃遮挡。
 * 顺序即 cardNumber 的 1-based 编号顺序（与 visibleAnchors 默认序一致）。
 */
const SCATTER_TABLE: Record<GlobalCardAnchor, ScatterEntry> = {
  default: { x: 3, y: 2, r: -3 },
  editor: { x: 47, y: 5, r: 4 },
  limits: { x: 8, y: 33, r: 2 },
  logger: { x: 52, y: 35, r: -2 },
  compression: { x: 4, y: 62, r: -4 },
  "memory-global": { x: 49, y: 64, r: 3 },
  "memory-workspace": { x: 26, y: 82, r: -2 },
};

/** 长按阈值（ms）：按下保持超过此时长才进入拖拽；短按只置顶，避免一点即拖。 */
const LONG_PRESS_MS = 320;
/** 内缩 clamp（px）：卡 left/top 钳在 [SHIELD, size - SHIELD]，防 box-shadow 被画布边缘裁切。 */
const SHIELD_PX = 8;
/** z-index 地板：避开 hover 2/3 与 modal 270-320 层。 */
const BASE_Z = 10;

/** 卡片运行时状态：pos（px）+ z。旋转由 SCATTER_TABLE 静态给定（不进 reactive）。 */
interface CardRuntime {
  x: number;
  y: number;
  z: number;
}

/** 暴露给模板 :style 的 CSS 自定义属性包。 */
export interface CardStyle {
  "--cx": string;
  "--cy": string;
  "--cr": string;
  "--i": string;
  zIndex: number;
}

/** 构建 7 张卡的初始状态（全部贴在 0,0 + BASE_Z）。 */
function initialCards(): Record<GlobalCardAnchor, CardRuntime> {
  const out = {} as Record<GlobalCardAnchor, CardRuntime>;
  (Object.keys(SCATTER_TABLE) as GlobalCardAnchor[]).forEach((k) => {
    out[k] = { x: 0, y: 0, z: BASE_Z };
  });
  return out;
}

export function useCardScatter(
  canvasRef: Readonly<Ref<HTMLElement | null>>,
  visibleAnchors: ComputedRef<GlobalCardAnchor[]>,
): {
  ready: Ref<boolean>;
  activeAnchor: Ref<GlobalCardAnchor | null>;
  draggingAnchor: Ref<GlobalCardAnchor | null>;
  pressedAnchor: Ref<GlobalCardAnchor | null>;
  enterSeq: Ref<number>;
  cardStyle: (anchor: GlobalCardAnchor) => CardStyle;
  cardClass: (anchor: GlobalCardAnchor) => Record<string, boolean>;
  cardNumber: (anchor: GlobalCardAnchor) => number;
  raise: (anchor: GlobalCardAnchor) => void;
  onPointerDown: (anchor: GlobalCardAnchor, e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  endPointer: (e: PointerEvent) => void;
  playEntry: () => void;
  onEnterEnd: (anchor: GlobalCardAnchor) => void;
} {
  // activeTab inject：v-show 切换时 RO 可能错过（同一帧大小未变），watch 是兜底。
  const activeTab = inject(SETTINGS_ACTIVE_TAB_KEY);
  /** 本 tab 是否处于激活（控制左下角数字索引 Teleport 的显隐）。 */
  const isActive = computed(() => !!activeTab && activeTab.value === "global");

  /** 每张卡的运行时 pos/z（响应式，驱动 :style）。 */
  const cards = reactive<Record<GlobalCardAnchor, CardRuntime>>(initialCards());

  /** 布局是否完成（防止 RO 重算覆盖用户拖拽）。 */
  const ready = ref(false);
  const activeAnchor = ref<GlobalCardAnchor | null>(null);
  const draggingAnchor = ref<GlobalCardAnchor | null>(null);
  /** pointerdown 即置位，pointerup/cancel 清零；CSS .is-pressed 用。 */
  const pressedAnchor = ref<GlobalCardAnchor | null>(null);
  /** 入场动画序号（递增触发 :class 重绑，方便调试/扩展）。 */
  const enterSeq = ref(0);
  /** 当前正入场动画中的卡集合（animationend / 兜底定时器清除）。 */
  const enteringSet = reactive(new Set<GlobalCardAnchor>());

  // 单调递增的最高 z（每次 raise 自增）。非响应式：仅通过 cards[a].z 驱动 topZCard computed。
  let topZ = BASE_Z;
  let pendingEntry = false;
  let entryFallbackTimer: ReturnType<typeof setTimeout> | undefined;

  /** 当前 z 最高的可见卡（用于 .is-top 视觉特效：边光 + 加深模糊）。 */
  const topZCard = computed<GlobalCardAnchor | null>(() => {
    let maxZ = -1;
    let maxAnchor: GlobalCardAnchor | null = null;
    for (const a of visibleAnchors.value) {
      const z = cards[a].z;
      if (z > maxZ) {
        maxZ = z;
        maxAnchor = a;
      }
    }
    return maxAnchor;
  });

  // ── 拖拽态（非响应式：仅拖拽期内部用） ──
  let downX = 0;
  let downY = 0;
  let downCardX = 0;
  let downCardY = 0;
  let activePointerId: number | null = null;
  let activePointerTarget: HTMLElement | null = null;
  /** 长按计时器：到点 arm 拖拽。 */
  let dragArmTimer: ReturnType<typeof setTimeout> | undefined;
  /** 是否已 arm（长按到点）→ 此后 pointermove 才真正拖动。 */
  let armed = false;

  let ro: ResizeObserver | undefined;
  let stopActiveTabWatch: (() => void) | undefined;

  /**
   * 按 SCATTER_TABLE 把百分比换算成 px 写入 cards。
   * 幂等：ready=true 后早返（保留用户拖拽位置）。
   */
  function layout(): void {
    if (ready.value) return;
    const el = canvasRef.value;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w === 0 || h === 0) return; // v-show 隐藏中，等下次 RO/watch 触发
    const usableW = Math.max(0, w - SHIELD_PX * 2);
    const usableH = Math.max(0, h - SHIELD_PX * 2);
    (Object.keys(SCATTER_TABLE) as GlobalCardAnchor[]).forEach((anchor) => {
      const e = SCATTER_TABLE[anchor];
      cards[anchor].x = SHIELD_PX + (e.x / 100) * usableW;
      cards[anchor].y = SHIELD_PX + (e.y / 100) * usableH;
    });
    ready.value = true;
    if (pendingEntry) {
      pendingEntry = false;
      playEntry();
    }
  }

  function cardStyle(anchor: GlobalCardAnchor): CardStyle {
    const c = cards[anchor];
    const idx = visibleAnchors.value.indexOf(anchor);
    return {
      "--cx": `${c.x}px`,
      "--cy": `${c.y}px`,
      "--cr": `${SCATTER_TABLE[anchor].r}deg`,
      "--i": String(idx >= 0 ? idx : 0),
      zIndex: c.z,
    };
  }

  function cardClass(anchor: GlobalCardAnchor): Record<string, boolean> {
    return {
      "is-active": activeAnchor.value === anchor,
      "is-dragging": draggingAnchor.value === anchor,
      "is-pressed": pressedAnchor.value === anchor,
      "is-top": topZCard.value === anchor,
      "is-entering": enteringSet.has(anchor),
    };
  }

  function cardNumber(anchor: GlobalCardAnchor): number {
    const i = visibleAnchors.value.indexOf(anchor);
    return i >= 0 ? i + 1 : 0;
  }

  /** 置顶：topZ 单调递增后赋给目标卡。幂等（连续点击同一卡只是 z 不变）。 */
  function raise(anchor: GlobalCardAnchor): void {
    topZ += 1;
    cards[anchor].z = topZ;
    activeAnchor.value = anchor;
  }

  function onPointerDown(anchor: GlobalCardAnchor, e: PointerEvent): void {
    // 仅主键响应（右键 / 中键放过，交给原生菜单）
    if (e.button !== 0) return;
    raise(anchor);
    pressedAnchor.value = anchor;
    downX = e.clientX;
    downY = e.clientY;
    downCardX = cards[anchor].x;
    downCardY = cards[anchor].y;
    activePointerId = e.pointerId;
    activePointerTarget = e.currentTarget as HTMLElement;
    armed = false;
    // 长按才进拖拽：短按只置顶（+ 拿起回弹）。到点 armDrag 捕获指针 + 锁选区。
    if (dragArmTimer) clearTimeout(dragArmTimer);
    dragArmTimer = setTimeout(armDrag, LONG_PRESS_MS);
  }

  /** 长按到点：捕获指针、锁 body 选区、标记 armed，此后 pointermove 才拖动。 */
  function armDrag(): void {
    if (pressedAnchor.value === null || activePointerTarget === null) return;
    armed = true;
    draggingAnchor.value = pressedAnchor.value;
    try {
      activePointerTarget.setPointerCapture(activePointerId!);
    } catch {
      /* setPointerCapture 抛异常不致命：仍按客户端坐标拖 */
    }
    document.body.style.userSelect = "none";
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointerId !== e.pointerId || pressedAnchor.value === null) return;
    if (!armed) return; // 长按未到点不拖（短按只置顶）
    const anchor = pressedAnchor.value;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    const el = canvasRef.value;
    const maxX = el ? el.clientWidth - SHIELD_PX : Number.POSITIVE_INFINITY;
    const maxY = el ? el.clientHeight - SHIELD_PX : Number.POSITIVE_INFINITY;
    cards[anchor].x = Math.max(SHIELD_PX, Math.min(maxX, downCardX + dx));
    cards[anchor].y = Math.max(SHIELD_PX, Math.min(maxY, downCardY + dy));
  }

  function endPointer(e: PointerEvent): void {
    if (activePointerId !== e.pointerId) return;
    if (dragArmTimer) {
      clearTimeout(dragArmTimer);
      dragArmTimer = undefined;
    }
    if (armed && activePointerTarget?.hasPointerCapture(e.pointerId)) {
      activePointerTarget.releasePointerCapture(e.pointerId);
    }
    if (draggingAnchor.value !== null) draggingAnchor.value = null;
    if (pressedAnchor.value !== null) pressedAnchor.value = null;
    document.body.style.userSelect = "";
    activePointerId = null;
    activePointerTarget = null;
    armed = false;
  }

  function playEntry(): void {
    // 准入：未 ready 时延后到 layout 成功后再放（cards 此时无位置，坠落无意义）。
    if (!ready.value) {
      pendingEntry = true;
      return;
    }
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      // reduced-motion：跳过动画，cards 直接到位。
      enteringSet.clear();
      return;
    }
    enteringSet.clear();
    for (const a of visibleAnchors.value) enteringSet.add(a);
    enterSeq.value += 1;
    // 兜底定时：animationend 万一漏触（CSS 动画被覆盖/打断），保证 .is-entering 不残留。
    if (entryFallbackTimer) clearTimeout(entryFallbackTimer);
    // 7 卡最大 stagger 6*55ms=330ms + duration 500ms + 200ms 缓冲 = 1030ms
    entryFallbackTimer = setTimeout(() => {
      enteringSet.clear();
      entryFallbackTimer = undefined;
    }, 1100);
  }

  function onEnterEnd(anchor: GlobalCardAnchor): void {
    enteringSet.delete(anchor);
    if (enteringSet.size === 0 && entryFallbackTimer) {
      clearTimeout(entryFallbackTimer);
      entryFallbackTimer = undefined;
    }
  }

  onMounted(() => {
    // 主路径：ResizeObserver 在 v-show 由 hidden → visible 时会触发（clientWidth 0 → 非 0）。
    const el = canvasRef.value;
    if (el && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => layout());
      ro.observe(el);
    }
    // 兜底 1：mount 时若已可见（非默认 tab 切到 global 而后又重开等边缘路径），nextTick 直接尝试。
    nextTick(layout);
    // 兜底 2：watch activeTab——v-show 同帧大小不变时 RO 可能不触发，显式切 tab 时再 layout + playEntry。
    //   getter 形式（() => activeTab.value）兼容 Readonly<Ref>，避开 Ref vs Readonly<Ref> 赋值窄化。
    if (activeTab) {
      const tabRef = activeTab;
      stopActiveTabWatch = watch(
        () => tabRef.value,
        (tab) => {
          if (tab === "global") {
            nextTick(() => {
              layout();
              playEntry();
            });
          }
        },
        { immediate: true },
      );
    }
  });

  onBeforeUnmount(() => {
    ro?.disconnect();
    ro = undefined;
    stopActiveTabWatch?.();
    if (entryFallbackTimer) {
      clearTimeout(entryFallbackTimer);
      entryFallbackTimer = undefined;
    }
    if (dragArmTimer) {
      clearTimeout(dragArmTimer);
      dragArmTimer = undefined;
    }
    // 防御：拖拽中卸载（理论不达）还原 body 样式。
    document.body.style.userSelect = "";
  });

  return {
    ready,
    activeAnchor,
    isActive,
    draggingAnchor,
    pressedAnchor,
    enterSeq,
    cardStyle,
    cardClass,
    cardNumber,
    raise,
    onPointerDown,
    onPointerMove,
    endPointer,
    playEntry,
    onEnterEnd,
  };
}
