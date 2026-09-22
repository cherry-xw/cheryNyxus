import { useAgentsStore, useAuthStore, useChatSessionsStore, useConnectionStore, useThemeStore } from '@/stores'

/** Sole adapter from the Nyxus bounded context to application state. */
export function useNyxusHost() {
  return {
    agents: useAgentsStore(),
    chats: useChatSessionsStore(),
    auth: useAuthStore(),
    connection: useConnectionStore(),
    theme: useThemeStore(),
  }
}

export type NyxusHostPort = ReturnType<typeof useNyxusHost>
