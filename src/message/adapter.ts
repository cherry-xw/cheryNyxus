import { type Role } from "./messageFactory.ts";

/**
 * Adapter 接口：定义取值策略
 */
export type ProviderAdapter<T = unknown> = {
  role: (raw: T) => Role;
  content: (raw: T) => string;
  thinking?: (raw: T) => string | undefined;
};

/**
 * Provider 注册表
 */
export const providerRegistry = new Map<string, ProviderAdapter>();

/**
 * 注册 provider 的 adapter
 */
export function registerAdapter<T>(
  provider: string,
  adapter: ProviderAdapter<T>,
): void {
  providerRegistry.set(provider, adapter as ProviderAdapter);
}
