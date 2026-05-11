/**
 * Tool 监管等级枚举
 * - auto: 自动执行，无需确认
 * - confirm: 需用户确认后执行
 * - manual: 禁止自动执行，仅手动触发
 */
export enum SupervisionLevel {
  auto = 0,
  confirm = 1,
  manual = 2,
}