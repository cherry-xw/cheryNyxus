/**
 * markdown 渲染工具。
 * - markdown-it：html:false（不解析原始 HTML，内建实体转义 → XSS 安全）
 * - highlight.js：代码块按语言高亮；未知语言降级为转义纯文本
 * 用于历史会话 MessageBubble 的 assistant/role（旧历史 subagent）content 渲染。
 * 安全：html:false 保证 LLM 输出中的 <script>/<img onerror> 等被转义为文本，不注入。
 */
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import type { MediaAssetRef } from '@/stores/agents/types'

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(str: string, lang: string): string {
    const language = lang && hljs.getLanguage(lang) ? lang : ''
    const code = language ? hljs.highlight(str, { language }).value : md.utils.escapeHtml(str)
    return `<pre class="hljs"><code>${code}</code></pre>`
  },
})

/** 渲染 markdown 文本为 HTML 字符串（供 v-html，已转义安全）。 */
export function renderMarkdown(src: string): string {
  return md.render(src ?? '')
}

/** 扩展名 → MIME 类型映射。 */
const EXT_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
}

/**
 * 从文本内容提取 `/api/media/<filename>` URL 列表。
 * 用于 HistoryItem 构建时预解析，避免每次渲染重复正则匹配。
 */
export function extractMediaUrls(text: string): MediaAssetRef[] {
  const matches = [...text.matchAll(/\/api\/media\/([a-f0-9-]+\.[a-z0-9]+)/gi)]
  return matches.map((m) => {
    const filename = m[1]!
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const mimeType = EXT_MIME_MAP[ext] ?? 'application/octet-stream'
    const kind: MediaAssetRef['kind'] = mimeType.startsWith('image/')
      ? 'image'
      : mimeType.startsWith('video/')
        ? 'video'
        : mimeType.startsWith('audio/')
          ? 'audio'
          : 'image'
    return { filename, kind, mimeType }
  })
}
