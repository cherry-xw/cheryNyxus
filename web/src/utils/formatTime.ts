/**
 * formatTime：消息气泡 / 会话列表时间戳常显工具（同天/跨天/跨年分级）。
 * - 同天（与 now 同年月日） → HH:MM
 * - 跨天（同年内不同日）  → MM-DD HH:MM
 * - 跨年                 → YYYY-MM-DD HH:MM
 * - ts 缺失 / 非有限数    → 返回 ''（调用方按空串走 v-if 不渲染）
 * 手写格式化（getHours/getMinutes 等本地时区） + padStart 补零，避开不同 locale 下
 * toLocaleString 分隔符差异；now 可注入（测试用），默认 Date.now()。
 */
export function formatTime(ts?: number, now: number = Date.now()): string {
  if (ts === undefined || ts === null || !Number.isFinite(ts)) return "";
  const t = new Date(ts);
  const n = new Date(now);
  const pad = (v: number): string => String(v).padStart(2, "0");
  const hh = pad(t.getHours());
  const mm = pad(t.getMinutes());
  // 同天：仅显 HH:MM
  if (
    t.getFullYear() === n.getFullYear() &&
    t.getMonth() === n.getMonth() &&
    t.getDate() === n.getDate()
  ) {
    return `${hh}:${mm}`;
  }
  const month = pad(t.getMonth() + 1);
  const day = pad(t.getDate());
  // 跨年（同年不同日已在上面排掉，此分支仅处理不同年）
  if (t.getFullYear() !== n.getFullYear()) {
    return `${t.getFullYear()}-${month}-${day} ${hh}:${mm}`;
  }
  // 跨天（同年内）
  return `${month}-${day} ${hh}:${mm}`;
}