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
    const code = language
      ? hljs.highlight(source, { language }).value
      : md.utils.escapeHtml(source)
    return `<pre class="hljs"><code>${code}</code></pre>`
  },
})

export function renderMarkdown(source: string): string {
  return md.render(source ?? '')
}
