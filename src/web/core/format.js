/**
 * 格式化工具：JSON 美化 / sense 参数 / 监管等级 / 时间 / 截断
 */

/** 尝试 JSON 美化，失败原样返回（字符串）或 stringify（对象） */
export function prettyJSON(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    if (!v) return "";
    try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; }
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

/**
 * 结构化解析（argument / result 通用）：
 * 成功返回美化文本 + ok:true；失败（非合法 JSON）原样文本 + ok:false。
 * 前端据 ok 切换 .json / .raw 样式。
 */
export function parseStyled(v) {
  if (v == null) return { ok: false, text: "" };
  if (typeof v === "string") {
    if (!v) return { ok: false, text: "" };
    try { return { ok: true, text: JSON.stringify(JSON.parse(v), null, 2) }; }
    catch { return { ok: false, text: v }; }
  }
  try { return { ok: true, text: JSON.stringify(v, null, 2) }; }
  catch { return { ok: false, text: String(v) }; }
}

/**
 * JSON 文本 → 着色 HTML：先整体 HTML 转义防 XSS，再正则匹配 JSON token 包 span。
 * 仅在 parseStyled.ok=true 时调用（输入保证合法 JSON）。
 */
export function highlightJSON(text) {
  if (!text) return "";
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(
    /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, key, str, bool, num) => {
      if (key) return `<span class="json-key">${key}</span>`;
      if (str) return `<span class="json-str">${str}</span>`;
      if (bool) return `<span class="json-bool">${bool}</span>`;
      if (num) return `<span class="json-num">${num}</span>`;
      return m;
    },
  );
}

/**
 * 结构化键值渲染（argument 专用）：
 * - 顶层 JSON 对象 → { mode:"kv", html } 键值行表（key → value）
 * - JSON 但非对象（数组/原始值）→ { mode:"json", text } 美化 JSON（交 highlightJSON 着色）
 * - 非 JSON → { mode:"raw", text } 原样文本
 */
export function renderKV(v) {
  if (v == null || v === "") return { mode: "raw", text: "" };
  let obj;
  if (typeof v === "string") {
    try { obj = JSON.parse(v); } catch { return { mode: "raw", text: v }; }
  } else {
    obj = v;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { mode: "json", text: JSON.stringify(obj, null, 2) };
  }
  const rows = Object.entries(obj).map(([k, val]) =>
    `<div class="kv-row"><span class="kv-key">${escHtml(k)}</span><span class="kv-sep">→</span><span class="kv-val">${renderVal(val)}</span></div>`
  );
  return { mode: "kv", html: rows.join("") };
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderVal(val) {
  if (val == null) return `<span class="json-bool">null</span>`;
  if (typeof val === "boolean") return `<span class="json-bool">${val}</span>`;
  if (typeof val === "number") return `<span class="json-num">${val}</span>`;
  if (typeof val === "string") return `<span class="json-str">${escHtml(val)}</span>`;
  // 嵌套 object/array → 美化 JSON 着色
  return `<span class="kv-nested">${highlightJSON(JSON.stringify(val, null, 2))}</span>`;
}

const LEVELS = {
  0: { name: "AUTO", badge: "badge-auto" },
  1: { name: "CONFIRM", badge: "badge-confirm" },
  2: { name: "MANUAL", badge: "badge-manual" },
};
/** 监管等级 → { name, badge } */
export function levelInfo(level) {
  return LEVELS[level] ?? { name: `L${level ?? "?"}`, badge: "badge-confirm" };
}

export function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function truncate(s, n = 60) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** sense list 元素解析 :level 后缀 → { name, level } */
export function parseSenseEntry(entry) {
  const [name, level] = String(entry).split(":");
  return { name, level: level ?? null };
}
