/**
 * 凭据解析 + git 可用性探测共享层（plugin / skill 导入复用）。
 *
 * - isGitAvailable：探测 git CLI（硬性前提），不抛错返 boolean。
 * - resolveAuth：凭据池 id -> GitAuth（后端解密）。密令缺失/不可解 -> 抛友好错误。
 * - resolveInlineAuth：inline {username,password,remember,label} -> {auth, savedCredentialId}。
 *   remember=true 时入池并回填 savedCredentialId。
 *
 * 从 plugin/import.ts 抽出以避免 skill/import.ts 复制第二份（规则 8：勿重复实现）。
 */
import { getCredentialSecret, getCredentialUsername, saveCredential } from "@/utils/secretStore.js";
import { ensureGitAvailable, type GitAuth } from "./gitClone.js";
import type { ParsedGithubUrl } from "./importShared.js";

/** git 是否可用（硬性前提探测）。不抛错，返回 boolean。 */
export async function isGitAvailable(): Promise<boolean> {
  try {
    await ensureGitAvailable();
    return true;
  } catch {
    return false;
  }
}

/** 凭据池 id -> GitAuth（后端解密）。密令缺失/不可解 -> 抛友好错误。 */
export function resolveAuth(credentialId: string): GitAuth {
  const username = getCredentialUsername(credentialId);
  const password = getCredentialSecret(credentialId);
  if (!username || password === undefined) {
    throw new Error(`凭据 ${credentialId} 不可用（已删除或主密钥变更），请重新输入`);
  }
  return { username, password };
}

export interface InlineAuthResult {
  auth: GitAuth | undefined;
  /** remember=true 且入池成功时回填的新凭据 id。 */
  savedCredentialId?: string;
}

/**
 * inline {username,password,remember,label} -> {auth, savedCredentialId}。
 * username/password 缺失 -> auth=undefined（公开仓路径）。remember=true -> 入池回填 id。
 * label 缺省时用 `${owner}/${repo}` 派生（与原 plugin 行为一致）。
 */
export function resolveInlineAuth(
  parsed: ParsedGithubUrl,
  opts: { username?: string; password?: string; remember?: boolean; label?: string },
): InlineAuthResult {
  const { username, password, remember, label } = opts;
  if (!username || !password) return { auth: undefined };
  const auth: GitAuth = { username, password };
  if (remember) {
    const saved = saveCredential({
      label: label?.trim() || `${parsed.owner}/${parsed.repo}`,
      username,
      password,
    });
    return { auth, savedCredentialId: saved.id };
  }
  return { auth };
}
