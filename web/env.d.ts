/// <reference types="vite/client" />

import type { DesktopBridge } from './src/features/desktop/desktopBridge'

declare global {
  interface Window {
    __DESKTOP_BRIDGE__?: DesktopBridge
    __BACKEND_CONFIG__?: { wsPort: number; webPort: number; transport: 'binary' | 'json' }
    __BACKEND_HTTP_URL__?: string
    __PICK_DIRECTORY__?: () => Promise<string | null>
  }
}

export {}
