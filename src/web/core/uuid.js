/**
 * UUID v4 生成（兼容非 secure context）。
 *
 * crypto.randomUUID() 仅在 secure context（HTTPS 或 localhost/127.0.0.1）可用；
 * 通过 IP 访问 http 页面时为 undefined，降级为 Math.random 生成的 RFC 4122 v4。
 */
export function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // 非 secure context 降级：版本位 4 + 变体位 8，符合 RFC 4122 v4 格式
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
