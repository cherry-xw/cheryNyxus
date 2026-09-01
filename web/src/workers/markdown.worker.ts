/// <reference lib="webworker" />
import { renderMarkdown } from '@/utils/markdownEngine'

interface MarkdownWorkerRequest {
  id: number
  source: string
}

interface MarkdownWorkerResponse {
  id: number
  html?: string
  error?: string
}

self.addEventListener('message', (event: MessageEvent<MarkdownWorkerRequest>) => {
  const { id, source } = event.data
  try {
    const response: MarkdownWorkerResponse = { id, html: renderMarkdown(source) }
    self.postMessage(response)
  } catch (error) {
    const response: MarkdownWorkerResponse = {
      id,
      error: error instanceof Error ? error.message : String(error),
    }
    self.postMessage(response)
  }
})
