/** Runtime fallback values. Reading these never creates a configuration override. */
export const DEFAULT_COMMAND_CONFIG = {
  warn: { unit: 'percent', value: 0.6 },
  auto: { unit: 'percent', value: 0.8 },
  min_context_limit: 32_000,
  safety_margin: 1024,
} as const

export const DEFAULT_FILES_CONFIG = {
  imageGeneration: { defaultCount: 1 },
  maxUploadBytes: 100 * 1024 * 1024,
  imageContext: { mode: 'recent', recentUserTurns: 1, replacement: 'description', missingDescription: 'existing', maxDescriptionChars: 600, maxTotalDescriptionChars: 6000 },
  context: { recentUserTurns: 3, maxAssets: 10, maxBinaryBytes: 16 * 1024 * 1024, maxExtractedCharsPerAsset: 20_000, maxExtractedChars: 80_000, defaultImageVariant: 'adapted' },
  imageAdaptation: { maxBytes: 5_000_000, maxEdge: 2048, quality: 85 },
  unreferencedUploadRetentionHours: 24,
  unreferencedAssetRetentionHours: 24,
} as const

export const DEFAULT_GLOBAL_OPTIONS = {
  llm_request_timeout_ms: 600_000,
  sense_execute_timeout: 30_000,
  approval_timeout: 300_000,
  approval_hard_timeout: 1_800_000,
  disconnect_grace_ms: 15_000,
  maxLoopCount: 30,
  tree_full_render_threshold: 150,
  history_recall: { max_output_chars: 4000 },
  watchdog: { timeout_ms: 300_000, wake_on_timeout: false },
  logger: { level: 'info', output: ['console'], timestamp: true, location: true, format: 'json' },
  file_compression: { truncate_threshold: 102_400, truncate_preview_lines: 100, drain_preview_count: 3, log_file_extensions: ['.log', '.txt', '.out', '.err'] },
} as const
export const TREE_CARD_RENDER_LIMIT = 120
export const DEFAULT_MEMORY_CONFIG = {
  global: { max_count: 30, max_chars: 500 },
  workspace: { max_count: 15, max_chars: 500 },
} as const
export const DEFAULT_FILE_SERVICE_OPTIONS = { enabled: true, maxConcurrent: 2, timeoutMs: 600_000, queueTimeoutMs: 600_000 } as const
