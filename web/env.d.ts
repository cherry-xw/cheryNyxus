/// <reference types="vite/client" />

import type { FrontendPerformanceSnapshot } from './src/utils/performanceDiagnostics'

declare global {
  interface Window {
    __CHERY_PERF__?: {
      snapshot: () => FrontendPerformanceSnapshot
      reset: () => void
    }
  }
}

export {}
