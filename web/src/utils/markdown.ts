/**
 * markdown 渲染工具。
 * - markdown-it：html:false（不解析原始 HTML，内建实体转义 → XSS 安全）
 * - highlight.js：代码块按语言高亮；未知语言降级为转义纯文本
 * 用于历史会话 MessageBubble 的 assistant/subagent content 渲染。
 * 安全：html:false 保证 LLM 输出中的 <script>/<img onerror> 等被转义为文本，不注入。
 */
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(str: string, lang: string): string {
    const language = lang && hljs.getLanguage(lang) ? lang : "";
    const code = language
      ? hljs.highlight(str, { language }).value
      : md.utils.escapeHtml(str);
    return `<pre class="hljs"><code>${code}</code></pre>`;
  },
});

/** 渲染 markdown 文本为 HTML 字符串（供 v-html，已转义安全）。 */
export function renderMarkdown(src: string): string {
  return md.render(src ?? "");
}
