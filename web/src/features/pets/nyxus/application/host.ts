import { useAgentsStore, useChatSessionsStore, useConnectionStore, useThemeStore } from '@/stores'

/** Sole adapter from the Nyxus bounded context to application state. */
export function useNyxusHost() {
  return {
    agents: useAgentsStore(),
    chats: useChatSessionsStore(),
    connection: useConnectionStore(),
    theme: useThemeStore(),
  }
}

export type NyxusHostPort = ReturnType<typeof useNyxusHost>
