/**
 * 凭据池 RPC（通用：plugins / skills / 未来 commands 共享）。
 *
 * 密令后端 AES-256-GCM 加密存储（见 src/utils/secretStore.ts），list/save/delete 仅操作脱敏视图；
 * 密令永不回前端（list 只返 id/label/username）。字段名 password 命中 logger 自动脱敏。
 */
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type CredentialsListResponseData,
  type CredentialsSaveRequestData, type CredentialsSaveResponseData,
  type CredentialsDeleteRequestData, type CredentialsDeleteResponseData,
} from "../message/types.js";
import { listCredentials, saveCredential, deleteCredential } from "@/utils/secretStore.js";

export async function handleCredentialsList(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<CredentialsListResponseData> {
  return { credentials: listCredentials() };
}

export async function handleCredentialsSave(
  _ctx: HandlerContext,
  { label, username, password }: CredentialsSaveRequestData,
): Promise<CredentialsSaveResponseData> {
  const credential = saveCredential({ label, username, password });
  return { credential };
}

export async function handleCredentialsDelete(
  _ctx: HandlerContext,
  { id }: CredentialsDeleteRequestData,
): Promise<CredentialsDeleteResponseData> {
  deleteCredential(id);
  return { ok: true };
}

/** 注册凭据池 RPC handlers。 */
export function registerCredentialsHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.CREDENTIALS_LIST, handleCredentialsList);
  router.register(Method.CREDENTIALS_SAVE, handleCredentialsSave);
  router.register(Method.CREDENTIALS_DELETE, handleCredentialsDelete);
}
