import {
  onScopeDispose,
  readonly,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
  type Ref,
} from 'vue'
import { renderMarkdownAsync } from '@/utils/markdownClient'

export const MARKDOWN_PREVIEW_LIMIT = 12_000
const DEFAULT_UPDATE_INTERVAL_MS = 240

export interface RenderedMarkdownOptions {
  mode?: 'full' | 'preview'
  intervalMs?: number
}

export interface RenderedMarkdownState {
  html: Readonly<Ref<string>>
  pending: Readonly<Ref<boolean>>
  flush: () => void
}

function previewSource(content: string): string {
  return content.length > MARKDOWN_PREVIEW_LIMIT
    ? `${content.slice(0, MARKDOWN_PREVIEW_LIMIT)}\n\n> 内容较长，当前展示前 12000 个字符。`
    : content
}

export function useRenderedMarkdown(
  source: MaybeRefOrGetter<string>,
  options: RenderedMarkdownOptions = {},
): RenderedMarkdownState {
  const mode = options.mode ?? 'preview'
  const intervalMs = Math.min(2_000, Math.max(32, options.intervalMs ?? DEFAULT_UPDATE_INTERVAL_MS))
  const html = ref('')
  const pending = ref(false)
  let latest = ''
  let revision = 0
  let renderedOnce = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const renderLatest = async (): Promise<void> => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const currentRevision = revision
    const input = mode === 'preview' ? previewSource(latest) : latest
    if (!input) {
      html.value = ''
      pending.value = false
      return
    }
    pending.value = true
    const result = await renderMarkdownAsync(input)
    if (disposed || currentRevision !== revision) return
    html.value = result
    pending.value = false
  }

  const flush = (): void => {
    void renderLatest()
  }

  watch(
    () => toValue(source),
    (content) => {
      latest = content ?? ''
      revision += 1
      if (!latest) {
        if (timer) clearTimeout(timer)
        timer = undefined
        renderedOnce = false
        html.value = ''
        pending.value = false
        return
      }
      if (!renderedOnce) {
        renderedOnce = true
        flush()
        return
      }
      if (!timer) timer = setTimeout(flush, intervalMs)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    disposed = true
    revision += 1
    if (timer) clearTimeout(timer)
    timer = undefined
  })

  return { html: readonly(html), pending: readonly(pending), flush }
}
