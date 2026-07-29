/// <reference types="vite/client" />

import type { DesktopPetBridge } from './src/features/pets/desktopPetBridge'

declare global {
  interface Window {
    __DESKTOP_PET__?: DesktopPetBridge
    __BACKEND_CONFIG__?: { wsPort: number; webPort: number; transport: 'binary' | 'json' }
    __BACKEND_HTTP_URL__?: string
    __PICK_DIRECTORY__?: () => Promise<string | null>
  }
}

export {}
