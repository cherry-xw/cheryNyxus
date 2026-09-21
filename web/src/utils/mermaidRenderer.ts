/**
 * Mermaid 图表浏览器侧渲染。
 *
 * 分工：markdown-it 引擎（markdownEngine.ts）把 ```mermaid / ```mmd 围栏输出为
 * 转义后的 `<pre class="mermaid">` 占位（Worker 与主线程共用，纯字符串变换）；
 * 本模块在 DOM 挂载后把占位渲染成 SVG 图表。
 *
 * - 懒加载：mermaid 体积大，首次出现图表时才动态导入（独立 chunk，不进首屏）。
 * - 自动渲染：MutationObserver 监听 DOM 子树，新增的 `pre.mermaid` 自动渲染，
 *   因此所有 v-html markdown 消费面（聊天/桌宠/lite/弹窗/统计等）无需逐个模板接入。
 * - 主题：渲染时按 `documentElement.dataset.theme` 选 mermaid default/dark 主题；
 *   主题切换时重绘已渲染图表，保持深浅色一致。
 * - 安全：mermaid 保持默认 `securityLevel: 'strict'`（内部 DOMPurify 清洗输出）；
 *   围栏源码已由引擎转义，mermaid 从节点 textContent 读取原文。
 * - 失败语义：`parse` 预校验失败时标记 error 并保留转义原文可见（等同普通代码块回退）；
 *   流式过程中的半成品源码同样暂缓，内容更新重建节点后自动重试。
 */
import type { Mermaid } from 'mermaid'

let mermaidPromise: Promise<Mermaid | null> | null = null
let observer: MutationObserver | null = null
let started = false
let diagramSequence = 0
/** 串行渲染队列：避免流式更新时多个 parse/render 交错执行。 */
let renderQueue: Promise<void> = Promise.resolve()
/** 记录已渲染节点的图表源码，供主题切换时重绘。 */
const diagramSources = new WeakMap<HTMLElement, string>()

function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === 'dark'
}

function loadMermaid(): Promise<Mermaid | null> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkTheme() ? 'dark' : 'default',
        })
        return mermaid
      })
      .catch(() => null)
  }
  return mermaidPromise
}

async function renderNode(node: HTMLElement): Promise<void> {
  // 等待期间节点可能已被 v-html 重建（detach），跳过；新节点会自行入队。
  if (!node.isConnected) return
  const source = (node.textContent ?? '').trim()
  if (!source) {
    node.dataset.mermaid = 'error'
    return
  }
  const mermaid = await loadMermaid()
  if (!mermaid || !node.isConnected) return
  const id = `chery-mermaid-${++diagramSequence}`
  try {
    const valid = await mermaid.parse(source, { suppressErrors: true })
    if (!valid) {
      node.dataset.mermaid = 'error'
      return
    }
    if (!node.isConnected) return
    const { svg, bindFunctions } = await mermaid.render(id, source)
    if (!node.isConnected) return
    diagramSources.set(node, source)
    node.innerHTML = svg
    bindFunctions?.(node)
    node.dataset.mermaid = 'rendered'
  } catch {
    node.dataset.mermaid = 'error'
  }
}

function scheduleNode(node: HTMLElement): void {
  const state = node.dataset.mermaid
  if (state === 'pending' || state === 'rendered' || state === 'error') return
  node.dataset.mermaid = 'pending'
  renderQueue = renderQueue.then(() => renderNode(node)).catch(() => undefined)
}

function scanContainer(root: Node): void {
  if (!(root instanceof Element)) return
  const nodes = root.matches('pre.mermaid')
    ? [root]
    : Array.from(root.querySelectorAll('pre.mermaid'))
  for (const node of nodes) scheduleNode(node as HTMLElement)
}

/** 主题切换后重绘已渲染图表（源码来自 WeakMap，避免二次读取已替换的 SVG）。 */
async function rerenderOnThemeChange(): Promise<void> {
  const mermaid = await loadMermaid()
  if (!mermaid) return
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDarkTheme() ? 'dark' : 'default',
  })
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('pre.mermaid[data-mermaid="rendered"]'),
  )
  for (const node of nodes) {
    const source = diagramSources.get(node)
    if (!source) continue
    const id = `chery-mermaid-${++diagramSequence}`
    try {
      const { svg } = await mermaid.render(id, source)
      if (!node.isConnected) continue
      node.innerHTML = svg
    } catch {
      // 单张重绘失败保留旧图，不阻塞其余节点
    }
  }
}

/**
 * 启动全局自动渲染（组合根调用一次）：
 * 观察 documentElement 子树中新增的 `pre.mermaid` 节点并渲染；
 * 观察 `data-theme` 变化并重绘已渲染图表。
 */
export function setupMermaidAutoRender(): void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return
  started = true
  if (typeof MutationObserver === 'undefined') return
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'data-theme') {
          renderQueue = renderQueue.then(() => rerenderOnThemeChange()).catch(() => undefined)
        }
        continue
      }
      for (const added of mutation.addedNodes) scanContainer(added)
    }
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  // 兜底：观察器启动前已挂载的图表（如恢复的历史会话）
  scanContainer(document.body)
}
