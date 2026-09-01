/**
 * markdown 渲染工具。
 * - markdown-it：html:false（不解析原始 HTML，内建实体转义 → XSS 安全）
 * - highlight.js：代码块按语言高亮；未知语言降级为转义纯文本
 * 用于历史会话 MessageBubble 的 assistant/role（旧历史 subagent）content 渲染。
 * 安全：html:false 保证 LLM 输出中的 <script>/<img onerror> 等被转义为文本，不注入。
 */
export { renderMarkdown } from './markdownEngine'
export { extractMediaUrls } from './mediaUrls'
