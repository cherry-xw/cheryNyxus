/**
 * 共享 args 解析工具（SenseCallBox / ApprovalCard 共用）。
 *
 * 后端契约：arguments 可能是 JSON 字符串或 object。
 * parseArgs 尝试解析为 object，提取 description 字段作折叠标题，其余字段作 key:value 行。
 * 解析失败 → fallback = JSON pretty-print 字符串。
 */

export interface ArgsParsed {
  /** description 字段值（非空字符串）；存在则作 args 折叠标题。 */
  description: string | null;
  /** 除 description 外的其余字段（key 顺序保留）。 */
  entries: { key: string; value: unknown }[];
}

export interface ParseArgsResult {
  parsed: ArgsParsed | null;
  fallback: string;
}

/** 单个参数值的行内展示：标量原样，对象/数组 pretty-print。 */
export function formatArgValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 值格式化为显示字符串（用于 result / fallback）。 */
export function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return "";
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return v;
    }
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/**
 * 解析 args 为 object：string 先 JSON.parse，object 直用。
 * 解析失败 / 非对象 → parsed=null，调用方走 fallback JSON pre。
 */
export function parseArgs(args: unknown): ParseArgsResult {
  let obj: Record<string, unknown> | null = null;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    obj = args as Record<string, unknown>;
  } else if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed) {
      try {
        const p = JSON.parse(trimmed);
        if (p && typeof p === "object" && !Array.isArray(p)) {
          obj = p as Record<string, unknown>;
        }
      } catch {
        /* 非 JSON → fallback */
      }
    }
  }
  if (!obj) {
    return { parsed: null, fallback: formatValue(args) };
  }
  const entries: { key: string; value: unknown }[] = [];
  let description: string | null = null;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "description") {
      if (typeof v === "string" && v.trim()) description = v.trim();
      continue;
    }
    entries.push({ key: k, value: v });
  }
  return { parsed: { description, entries }, fallback: "" };
}
