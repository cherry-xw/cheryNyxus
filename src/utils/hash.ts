import { createHash } from "crypto";

/**
 * 生成SHA256 hash
 * @param data 格式必须为 `${string}::${string}`，如 "file::path:size:mtime:offset:limit"
 */
export function generateHash(data: `${string}::${string}`): string {
  return createHash("sha256").update(data).digest("hex");
}