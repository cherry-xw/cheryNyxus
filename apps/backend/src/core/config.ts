/**
 * Tool 监管等级枚举
 * - auto: 0 自动执行，无需确认
 * - smart: 1 智能监管：按规则表（sense/sensitivity.ts）判定，安全操作自动执行，敏感操作需确认（fail-safe 默认确认）
 * - manual: 2 禁止自动执行，仅手动触发
 */
export enum SupervisionLevel {
  auto = 0,
  smart = 1,
  manual = 2,
}
