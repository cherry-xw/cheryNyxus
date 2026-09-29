export { useAuthStore, useConnectionStore } from '@/stores'
export { configureRelayOidc } from '@/stores/auth'
export { hostOf, isLoopbackHost, normalizeAddress } from '@/domain/auth/serverAddress'
export type { AuthError, AuthMode, AuthTarget, RelayOidcAdapter, RelayOidcLoginInput } from '@/stores/auth'
