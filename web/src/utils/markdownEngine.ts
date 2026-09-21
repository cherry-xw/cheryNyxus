import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, language] of Object.entries({
  bash,
  shell: bash,
  sh: bash,
  css,
  javascript,
  js: javascript,
  json,
  markdown,
  md: markdown,
  powershell,
  ps1: powershell,
  python,
  py: python,
  sql,
  typescript,
  ts: typescript,
  html: xml,
  xml,
  yaml,
  yml: yaml,
})) {
  hljs.registerLanguage(name, language)
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  highlight(source: string, languageName: string): string {
    const language = languageName && hljs.getLanguage(languageName) ? languageName : ''
    const code = language ? hljs.highlight(source, { language }).value : md.utils.escapeHtml(source)
    return `<pre class="hljs"><code>${code}</code></pre>`
  },
})

// Mermaid 围栏：```mermaid / ```mmd 不交给 highlight.js，而是输出 <pre class="mermaid"> 占位，
// 由浏览器侧 mermaidRenderer（DOM 挂载后自动渲染）替换成 SVG 图表。
// 源码经 escapeHtml 转义（与默认 fence 一致，XSS 安全），mermaid 从 textContent 读取。
const defaultFence = md.renderer.rules.fence!
md.renderer.rules.fence = (tokens, idx, options, env, self): string => {
  const token = tokens[idx]
  if (!token) return defaultFence(tokens, idx, options, env, self)
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
  const language = info.split(/\s+/g)[0]
  if (language === 'mermaid' || language === 'mmd') {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`
  }
  return defaultFence(tokens, idx, options, env, self)
}

export function renderMarkdown(source: string): string {
  return md.render(source ?? '')
}
