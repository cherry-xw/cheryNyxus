import type { Ref } from "vue";

/** 4 个 overlay 组件共享的 pointerdown 判断：点击 overlay 自身（非 panel 子元素）时触发 close。 */
export function useOverlayClick(close: () => void) {
  return {
    onOverlayClick(e: MouseEvent) {
      if (e.target === e.currentTarget) close();
    },
  };
}

/** dialog 型面板（居中 fade+scale）过渡参数 */
export const dialogPanelTransition = { duration: 0.18, ease: "easeOut" as const };
/** drawer 型面板（右侧 slide）过渡参数 */
export const drawerPanelTransition = { duration: 0.24, ease: "easeOut" as const };
/** overlay 通用过渡参数 */
export const overlayTransition = { duration: 0.16 };
