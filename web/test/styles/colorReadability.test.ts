import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { contrastRatio, parseHex } from '../../src/utils/colorContrast'
import { NODE_ACCENT_LIGHT, NODE_SKINS } from '../../src/features/pets/nyxus/graph/nodeSkins'
import {
  signalAccentForTheme,
  type SignalNodeVisualKind,
} from '../../src/features/pets/nyxus/graph/executionPresentation'
import { ownerOverlayZIndex, WORKSPACE_WINDOW_Z_INDEX_STEP } from '../../src/styles/overlayLayers'

function rgb(value: string): number[] {
  return value
    .replace('#', '')
    .match(/../g)!
    .map((part) => Number.parseInt(part, 16))
}
function luminance(color: number[]): number {
  return color.reduce((sum, value, index) => {
    const s = value / 255
    return (
      sum +
      (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]!
    )
  }, 0)
}
function contrast(foreground: string, background: string, alpha = 1): number {
  const bg = rgb(background)
  const mixed = rgb(foreground).map((value, index) => value * alpha + bg[index]! * (1 - alpha))
  const a = luminance(mixed),
    b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('theme foreground/background pairing', () => {
  it('keeps every vivid tree-node accent distinguishable from its canvas', () => {
    const signalKinds: SignalNodeVisualKind[] = [
      'start',
      'input',
      'reply',
      'error',
      'fold',
      'process',
      'dispatch',
      'return',
      'system',
      'tool-command',
      'tool-read',
      'tool-write',
      'tool-search',
      'tool-skill',
      'tool-spawn',
      'tool-child',
      'tool-question',
      'tool-media',
      'tool-todo',
      'tool-memory',
      'tool-config',
      'tool-navigate',
      'tool-role',
      'tool-web',
      'tool-data',
      'tool-git',
      'tool-time',
      'tool-notify',
      'tool-generic',
    ]
    for (const theme of ['light', 'dark'] as const) {
      const background = theme === 'light' ? '#f5f7fc' : '#0b1020'
      const skinAccents =
        theme === 'light'
          ? NODE_ACCENT_LIGHT
          : Object.fromEntries(Object.entries(NODE_SKINS).map(([key, skin]) => [key, skin.accent]))
      for (const [key, accent] of Object.entries(skinAccents)) {
        expect(contrast(accent, background), `${theme}/skin/${key}`).toBeGreaterThanOrEqual(3)
      }
      for (const kind of signalKinds) {
        expect(
          contrast(signalAccentForTheme(theme, kind), background),
          `${theme}/signal/${kind}`,
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keeps semantic text and solid accent labels readable in both themes', () => {
    const css = readFileSync('web/src/styles/theme.css', 'utf8')
    for (const selector of [':root', "[data-theme='dark']"]) {
      const start = css.indexOf(`${selector} {`)
      const block = css.slice(start, css.indexOf('\n}', start))
      const token = (name: string) => new RegExp(`--${name}: (#[a-f\\d]{6})`, 'i').exec(block)![1]!
      expect(contrast(token('accent-ink'), token('accent'))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('accent'), token('panel'))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(token('info'), token('surface'))).toBeGreaterThanOrEqual(4.5)
      // Common chips use an 18% accent tint; labels use accent, not accent-ink.
      const soft = rgb(token('accent')).map((n, i) =>
        Math.round(n * 0.18 + rgb(token('panel'))[i]! * 0.82),
      )
      const softHex = `#${soft.map((n) => n.toString(16).padStart(2, '0')).join('')}`
      expect(contrast(token('accent'), softHex)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps primary tree edges visible after alpha blending', () => {
    // 连线改为两端节点色的渐变后，端点色（节点语义色 + Signal 状态覆盖色）即边色来源；
    // 该用例确保这些端点色在边线透明度混合后仍与画布背景可区分。
    const palette = readFileSync('web/src/composables/useThemeTokens.ts', 'utf8')
    const signalKinds: SignalNodeVisualKind[] = [
      'start',
      'input',
      'reply',
      'error',
      'fold',
      'process',
      'dispatch',
      'return',
      'system',
      'tool-command',
      'tool-read',
      'tool-write',
      'tool-search',
      'tool-skill',
      'tool-spawn',
      'tool-child',
      'tool-question',
      'tool-media',
      'tool-todo',
      'tool-memory',
      'tool-config',
      'tool-navigate',
      'tool-role',
      'tool-web',
      'tool-data',
      'tool-git',
      'tool-time',
      'tool-notify',
      'tool-generic',
    ]
    for (const theme of ['light', 'dark'] as const) {
      const block = palette.split(`${theme}: {`)[1]!.split('},')[0]!
      const alpha = Number(/edgeAlpha: ([\d.]+)/.exec(block)![1])
      const background = theme === 'light' ? '#f5f7fc' : '#0b1020'
      const skinAccents =
        theme === 'light'
          ? NODE_ACCENT_LIGHT
          : Object.fromEntries(Object.entries(NODE_SKINS).map(([key, skin]) => [key, skin.accent]))
      // stateRevoked 是刻意弱化的中性灰（撤销即淡化），不作为可见性校验对象；
      // 错误红与暂停琥珀必须醒目。
      const stateColors = ['stateError', 'statePaused'].map((name) => {
        const raw = new RegExp(`${name}: (0x[0-9a-f]+)`).exec(block)![1]!
        return `#${(Number(raw) & 0xffffff).toString(16).padStart(6, '0')}`
      })
      const accents = [
        ...Object.values(skinAccents),
        ...signalKinds.map((kind) => signalAccentForTheme(theme, kind)),
        ...stateColors,
      ]
      for (const accent of accents) {
        // 连线是 1.35px 装饰性连接线，不承担文本/大元素角色，2.5:1 已是清晰的可见下限
        // （WCAG 3:1 针对大文本/UI 组件，连线无需达到）。
        expect(contrast(accent, background, alpha), `${theme}/${accent}`).toBeGreaterThanOrEqual(
          2.5,
        )
      }
    }
  })

  it('places teleported menus above their owner but below the next window', () => {
    vi.stubGlobal('getComputedStyle', (element: { zIndex: string }) => element)
    const owner = { zIndex: '512' }
    const anchor = { closest: () => owner } as unknown as HTMLElement
    const z = ownerOverlayZIndex(anchor)
    expect(Number.isInteger(z)).toBe(true)
    expect(z).toBeGreaterThan(512)
    expect(z).toBeLessThan(512 + WORKSPACE_WINDOW_Z_INDEX_STEP)
    vi.unstubAllGlobals()
  })
})

// ══════════════════════════════════════════════════════════════════════
// 硬编码前景色扫描（防回归）
//
// 只扫 color/fill/stroke 前景声明（背景/边框不扫），var(--token) / color-mix 解析为
// 当前主题有效色后分三组断言：
//   1) [data-theme='dark'] 语境声明在深色表面（color 4.5 / fill·stroke 3.0）；
//   2) 基础声明在深色表面，除非同文件存在同末段选择器的 dark 覆盖，或列入豁免；
//   3) 基础声明在浅色表面 ≥3.0（宽松阈值 + 豁免名单；浅色不是本次主战场）；
//   4) 依赖同文件 dark 覆盖的基础声明，覆盖选择器特异性必须 ≥ 基础规则（否则覆盖
//      在浏览器里输给带 [data-v] 的 scoped 基础规则而不生效，扫描却误判为已覆盖）。
// 扫描文件范围：web/src 全部 .vue / .less / .css（.css 曾漏扫 LiteView.styles.css 的图标色）。
//
// 独立视觉身份（nyxus CRT --nx-*、paper/import 弹窗、Pixi、particle、桌宠、
// settings --neon-* / --cyber-*）与固定浅底/彩底徽章在豁免名单内，不纳入强制提亮。
// 深色提亮规则见 docs/standards/frontend/design-language.md §4.3。
// ══════════════════════════════════════════════════════════════════════

interface ForegroundDecl {
  file: string
  prop: string
  value: string
  selector: string
  darkContext: boolean
}

const SRC_ROOT = 'web/src'
const DARK_SURFACES = ['#0b1020', '#10162e', '#161d38', '#1b2444']
const LIGHT_SURFACES = ['#f5f7fc', '#fbfcff', '#ffffff']

/** 从 theme.css 提取 :root（浅）与 [data-theme='dark']（深）的十六进制 token。 */
function readThemeTokens(): Record<'light' | 'dark', Record<string, string>> {
  const css = readFileSync('web/src/styles/theme.css', 'utf8')
  const read = (selector: string): Record<string, string> => {
    const start = css.indexOf(`${selector} {`)
    const block = css.slice(start, css.indexOf('\n}', start))
    const out: Record<string, string> = {}
    for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)) {
      out[`--${m[1]}`] = m[2]!
    }
    return out
  }
  return { light: read(':root'), dark: read("[data-theme='dark']") }
}
const THEME_TOKENS = readThemeTokens()

function mixHex(c1: string, c2: string, p: number): string {
  const a = parseHex(c1)
  const b = parseHex(c2)
  if (!a || !b) return ''
  const m = a.map((v, i) => Math.round(v * (1 - p) + (b[i] ?? 0) * p))
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 把声明值解析为当前主题下的有效 hex；无法确定（el/nx/neon/cyber 家族、未知 var）返回 null。 */
function resolveColor(value: string, theme: 'light' | 'dark'): string | null {
  const v = value.trim()
  if (/var\(--(?:el|nx|neon|cyber)/.test(v)) return null
  if (!/#[0-9a-f]{6}|#[0-9a-f]{3}/i.test(v)) return null
  if (/^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(v)) return v
  const varM = /^var\((--[\w-]+)(?:\s*,\s*(.*))?\)$/.exec(v)
  if (varM) {
    const name = varM[1] ?? ''
    const token = THEME_TOKENS[theme][name]
    if (token) return token
    const fallback = varM[2]
    if (fallback !== undefined) return resolveColor(fallback, theme)
    return null
  }
  const mixM = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+)\)$/.exec(v)
  if (mixM) {
    const a = resolveColor(mixM[1] ?? '', theme)
    const b = resolveColor(mixM[3] ?? '', theme)
    if (a === null || b === null) return null
    return mixHex(a, b, 1 - Number.parseFloat(mixM[2] ?? '0') / 100)
  }
  return null
}

function minContrastOn(hex: string, surfaces: string[]): number {
  return Math.min(...surfaces.map((s) => contrastRatio(hex, s)))
}

function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i + 2)
      i = end === -1 ? src.length : end + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/** 只保留当前嵌套深度（brace depth 0）的文本，剔除嵌套规则内容，避免父块声明扫描误收子块。 */
function topLevelOnly(s: string): string {
  let out = ''
  let depth = 0
  for (const c of s) {
    if (c === '{') {
      depth++
      continue
    }
    if (c === '}') {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0) out += c
  }
  return out
}

/** 嵌套块 header 只取最后一个 `;` / `}` 之后的选择器，避免把父块内同级声明吞进 header。 */
function lastRuleHeader(text: string): string {
  const lastSep = Math.max(text.lastIndexOf(';'), text.lastIndexOf('}'))
  return text.slice(lastSep + 1).trim()
}

function cleanHeader(raw: string): string {
  return raw
    .replace(/:global\((.*?)\)/g, '$1')
    .replace(/:deep\((.*?)\)/g, '$1')
    .replace(/\[data-theme='?dark'?\]/gi, '')
    .replace(/html\.dark/gi, '')
    .replace(/^@media[^{]*/, '')
    .replace(/^@supports[^{]*/, '')
    .trim()
}

function isAtRule(header: string): boolean {
  return /^@/.test(header)
}

function buildChain(headers: string[]): string {
  let out = ''
  for (const h of headers) {
    const c = cleanHeader(h)
    if (!c) continue
    if (c.startsWith('&')) out = out ? out + c.replace(/&/g, '') : c.replace(/&/g, '')
    else out = out ? `${out} ${c}` : c
  }
  return out
}

function lastCompound(sel: string): string {
  const tokens = sel.split(/\s+/)
  return tokens[tokens.length - 1] ?? ''
}

/**
 * 计算选择器特异性 [id, class, type]。:not()/:is() 按 CSS 规范计入实参特异性；
 * :deep()/:global() 作为伪类计入 1（scoped 编译器产物分别再补 [data-v]/[data-theme] 属性，
 * 由调用方在两侧各 +1 抵消）。isIdentChar 显式判空，避免 sel[i] 为 undefined 时
 * 正则 test(undefined) 命中 "undefined" 里的字母导致死循环。
 */
function specificity(sel: string): [number, number, number] {
  const isIdentChar = (ch: string | undefined) => ch !== undefined && /[a-zA-Z0-9_-]/.test(ch)
  const walk = (s: string): [number, number, number] => {
    let a = 0
    let b = 0
    let c = 0
    let i = 0
    const n = s.length
    while (i < n) {
      const ch = s[i]!
      if (ch === '#') {
        i++
        while (isIdentChar(s[i])) i++
        a++
        continue
      }
      if (ch === '.') {
        i++
        while (isIdentChar(s[i])) i++
        b++
        continue
      }
      if (ch === '[') {
        i++
        while (i < n && s[i] !== ']') i++
        i++
        b++
        continue
      }
      if (ch === ':') {
        i++
        if (s[i] === ':') i++
        while (i < n && isIdentChar(s[i])) i++
        b++
        if (s[i] === '(') {
          const start = i + 1
          let depth = 1
          i = start
          while (i < n && depth > 0) {
            if (s[i] === '(') depth++
            else if (s[i] === ')') depth--
            i++
          }
          const inner = s.slice(start, i - 1).trim()
          if (inner) {
            const [ia, ib, ic] = walk(inner)
            a += ia
            b += ib
            c += ic
          }
        }
        continue
      }
      if (/[a-zA-Z]/.test(ch)) {
        c++
        while (isIdentChar(s[i])) i++
        continue
      }
      i++
    }
    return [a, b, c]
  }
  return walk(sel)
}

/** 比较两个特异性元组；返回 -1/0/1。 */
function cmpSpec(x: [number, number, number], y: [number, number, number]): number {
  if (x[0] !== y[0]) return x[0] - y[0] > 0 ? 1 : -1
  if (x[1] !== y[1]) return x[1] - y[1] > 0 ? 1 : -1
  if (x[2] !== y[2]) return x[2] - y[2] > 0 ? 1 : -1
  return 0
}

function collectDecls(
  body: string,
  selChain: string,
  darkContext: boolean,
  decls: ForegroundDecl[],
  file: string,
): void {
  const declRe = /(?:^|[;{}])\s*(background-)?(color|fill|stroke)\s*:\s*([^;{}]+)/g
  const bodyTop = topLevelOnly(body)
  let m: RegExpExecArray | null
  while ((m = declRe.exec(bodyTop))) {
    if (m[1]) continue
    const prop = m[2] ?? ''
    const value = (m[3] ?? '').trim()
    if (!/#[0-9a-f]{6}|#[0-9a-f]{3}/i.test(value)) continue
    const selectors = selChain
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const sel of selectors.length ? selectors : [selChain || '?']) {
      decls.push({ file, prop, value, selector: sel, darkContext })
    }
  }
}

function scanStyleBlockInto(
  file: string,
  body: string,
  parentStack: { header: string }[],
  decls: ForegroundDecl[],
): void {
  const stack = [...parentStack]
  let i = 0
  while (i < body.length) {
    const open = body.indexOf('{', i)
    if (open === -1) break
    const header = lastRuleHeader(body.slice(i, open))
    stack.push({ header })
    let depth = 1
    let j = open + 1
    while (j < body.length && depth > 0) {
      if (body[j] === '{') depth++
      else if (body[j] === '}') depth--
      j++
    }
    const inner = body.slice(open + 1, j - 1)
    const selectors = stack
      .filter((s) => !isAtRule(s.header))
      .map((s) => s.header)
      .filter(Boolean)
    const darkContext = /data-theme|html\.dark/i.test(selectors.join(' '))
    const selChain = buildChain(selectors)
    collectDecls(inner, selChain, darkContext, decls, file)
    if (inner.includes('{')) scanStyleBlockInto(file, inner, stack, decls)
    stack.pop()
    i = j
  }
}

function scanStyleBlock(file: string, src: string): ForegroundDecl[] {
  const decls: ForegroundDecl[] = []
  const stack: { header: string }[] = []
  let i = 0
  while (i < src.length) {
    const open = src.indexOf('{', i)
    if (open === -1) break
    const header = lastRuleHeader(src.slice(i, open))
    stack.push({ header })
    let depth = 1
    let j = open + 1
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') depth--
      j++
    }
    const body = src.slice(open + 1, j - 1)
    const selectors = stack
      .filter((s) => !isAtRule(s.header))
      .map((s) => s.header)
      .filter(Boolean)
    const darkContext = /data-theme|html\.dark/i.test(selectors.join(' '))
    const selChain = buildChain(selectors)
    collectDecls(body, selChain, darkContext, decls, file)
    if (body.includes('{')) scanStyleBlockInto(file, body, stack, decls)
    stack.pop()
    i = j
  }
  return decls
}

function collectStyleFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name)
    if (name.isDirectory()) out.push(...collectStyleFiles(p))
    else if (/\.(vue|less|css)$/.test(name.name)) out.push(p)
  }
  return out
}

function scanAllForegroundColors(): ForegroundDecl[] {
  const all: ForegroundDecl[] = []
  for (const file of collectStyleFiles(SRC_ROOT)) {
    const src = readFileSync(file, 'utf8')
    if (file.endsWith('.vue')) {
      const styleRe = /<style([^>]*)>([\s\S]*?)<\/style>/g
      let m: RegExpExecArray | null
      while ((m = styleRe.exec(src))) {
        all.push(...scanStyleBlock(file, stripComments(m[2] ?? '')))
      }
    } else {
      all.push(...scanStyleBlock(file, stripComments(src)))
    }
  }
  return dedupPrefix(all)
}

/** 同一 file|prop|value 组内，丢弃被更深选择器包含的浅层条目（仅保留最深选择器）。 */
function dedupPrefix(decls: ForegroundDecl[]): ForegroundDecl[] {
  const groups = new Map<string, ForegroundDecl[]>()
  for (const d of decls) {
    const key = `${d.file}|${d.prop}|${d.value}`
    const list = groups.get(key)
    if (list) list.push(d)
    else groups.set(key, [d])
  }
  const out: ForegroundDecl[] = []
  for (const list of groups.values()) {
    out.push(
      ...list.filter((d) => !list.some((o) => o !== d && isStrictPrefix(d.selector, o.selector))),
    )
  }
  return out
}

function isStrictPrefix(a: string, b: string): boolean {
  return a !== b && b.startsWith(`${a} `)
}

function rel(file: string): string {
  return path.relative(SRC_ROOT, file).replace(/\\/g, '/')
}

// 豁免：独立视觉身份（CRT/paper/import/桌宠/Pixi/neon）不纳入强制提亮。
const EXEMPT_FILES: RegExp[] = [
  /AudioPlayer\.vue$/,
  /PluginImportDialog\.styles\.less$/,
  /SkillImportDialog\.vue$/,
  /ImportConfirmDialog\.vue$/,
  /ImportPortalFrame\.vue$/,
  /RoleConfigPopover\.vue$/,
  /ThinkingLevelSwitch\.vue$/,
  /WorkbenchAgentUsageBar\.vue$/,
  /windowControls\.less$/,
  /shared-neon\.less$/,
  /neon\.less$/,
  /nyxus\//,
]
// 深色豁免：恒深卡、白底/浅底徽章、彩底 chip、图标（3.0 阈值已达标）。
const DARK_EXEMPT: { file: RegExp; selector: string | RegExp }[] = [
  { file: /MessageAvatar\.vue$/, selector: '.avatar' },
  { file: /MessageAvatar\.vue$/, selector: '.name-initial' },
  { file: /ApprovalCard\.vue$/, selector: '.btn.accept' },
  { file: /ApprovalCard\.vue$/, selector: '.btn.reject' },
  { file: /FileChangeDiff\.vue$/, selector: '.add' },
  { file: /FileChangeDiff\.vue$/, selector: '.remove' },
  { file: /PetIcons\.vue$/, selector: '.role-tag' },
  { file: /PetIcons\.vue$/, selector: /approval-icon/ },
  { file: /App\.vue$/, selector: /composer-title-attention/ },
]
// 浅色豁免：白底/浅色边界（浅色不是主战场，3.0 宽松阈值 + 白字/金字号全局豁免）。
const LIGHT_EXEMPT: { file: RegExp; selector?: string | RegExp }[] = [
  { file: /QuestionCard\.vue$/, selector: /is-paper/ },
  { file: /MediaThumbStrip\.vue$/, selector: /thumb-audio/ },
  { file: /SkillRenderer\.vue$/, selector: /skill-type/ },
  { file: /FileReadRenderer\.vue$/, selector: /compression-badge/ },
  { file: /DetailDrawer\.vue$/, selector: /data-tooltype=['"]web|dispatch|other/ },
  { file: /LiteToolCallDetail\.vue$/, selector: /data-tooltype=['"]web|dispatch|other/ },
  { file: /LabelTip\.vue$/ },
  { file: /WorkbenchDialog\.scoped\.less$/, selector: /nyxus-role-configs/ },
  { file: /TaskBrowser\.styles\.less$/, selector: /is-needs_user/ },
  // LiteView.styles.css 的 tooltype 图标基础色：web/dispatch/other 三色为既有浅色装饰图标色
  // （浅底 2.7 左右），深色已由同文件 [data-theme='dark'] 提亮块覆盖，浅色不纳入强制。
  { file: /LiteView\.styles\.css$/, selector: /data-tooltype=['"](web|dispatch|other)/ },
]
const GLOBAL_LIGHT_EXEMPT_HEX = new Set(['#ffffff', '#fff', '#eab308'])

function isExemptFile(file: string): boolean {
  return EXEMPT_FILES.some((re) => re.test(rel(file)))
}
function matchSel(selector: string, pattern: string | RegExp): boolean {
  return typeof pattern === 'string'
    ? selector === pattern || selector.endsWith(pattern)
    : pattern.test(selector)
}
function darkExempt(file: string, selector: string): boolean {
  return DARK_EXEMPT.some((e) => e.file.test(rel(file)) && matchSel(selector, e.selector))
}
function lightExempt(file: string, selector: string, hex: string): boolean {
  if (GLOBAL_LIGHT_EXEMPT_HEX.has(hex)) return true
  return LIGHT_EXEMPT.some(
    (e) => e.file.test(rel(file)) && (!e.selector || matchSel(selector, e.selector)),
  )
}

describe('hardcoded foreground colors stay readable', () => {
  const decls = scanAllForegroundColors()

  /** 同文件存在 dark 覆盖：覆盖选择器的末段复合以 base 末段结尾即视为已覆盖（如 .label-system 被 .ctx-legend-label.label-system 覆盖）。 */
  const hasSameFileDarkOverride = (file: string, selector: string): boolean => {
    const baseLast = lastCompound(selector)
    if (!baseLast) return false
    return decls.some(
      (d) => d.file === file && d.darkContext && lastCompound(d.selector).endsWith(baseLast),
    )
  }

  const darkContextFails: string[] = []
  const baseDarkFails: string[] = []
  const baseLightFails: string[] = []
  const specificityFails: string[] = []
  const format = (d: ForegroundDecl, cr: number): string =>
    `[${rel(d.file)}] ${d.prop}:${d.value}  cr(${cr.toFixed(2)})  :: ${d.selector}`

  for (const d of decls) {
    if (isExemptFile(d.file)) continue
    const effDark = resolveColor(d.value, 'dark')
    if (effDark === null) continue
    const threshold = d.prop === 'color' ? 4.5 : 3.0
    const dk = minContrastOn(effDark, DARK_SURFACES)
    if (d.darkContext) {
      if (dk < threshold) darkContextFails.push(format(d, dk))
    } else {
      if (
        dk < threshold &&
        !hasSameFileDarkOverride(d.file, d.selector) &&
        !darkExempt(d.file, d.selector)
      ) {
        baseDarkFails.push(format(d, dk))
      }
      const effLight = resolveColor(d.value, 'light')
      if (effLight !== null) {
        const lk = minContrastOn(effLight, LIGHT_SURFACES)
        if (lk < 3.0 && !lightExempt(d.file, d.selector, effLight)) {
          baseLightFails.push(format(d, lk))
        }
      }
    }
  }

  // 依赖同文件 dark 覆盖的 base 声明：覆盖选择器特异性必须 >= 基础 scoped 规则。
  // 真实 CSS 里覆盖带 [data-theme='dark']（+1 属性）、基础带 [data-v]（+1 属性），两侧相抵；
  // 相等时须靠「覆盖块位于基础块之后」胜出（本项目覆盖块均追加在 scoped 块后的无 scoped 块或文件末尾）。
  for (const d of decls) {
    if (isExemptFile(d.file) || d.darkContext) continue
    const effDark = resolveColor(d.value, 'dark')
    if (effDark === null) continue
    const threshold = d.prop === 'color' ? 4.5 : 3.0
    const dk = minContrastOn(effDark, DARK_SURFACES)
    if (dk >= threshold || darkExempt(d.file, d.selector)) continue
    const baseLast = lastCompound(d.selector)
    if (!baseLast) continue
    const overrides = decls.filter(
      (o) => o.file === d.file && o.darkContext && lastCompound(o.selector).endsWith(baseLast),
    )
    if (!overrides.length) continue
    const baseSpec = specificity(d.selector)
    const enough = overrides.some((o) => {
      const cmp = cmpSpec(specificity(o.selector), baseSpec)
      return cmp > 0 || (cmp === 0 && decls.indexOf(o) > decls.indexOf(d))
    })
    if (!enough) {
      specificityFails.push(
        `[${rel(d.file)}] ${d.prop}:${d.value}  :: ${d.selector}  （覆盖特异性不足：` +
          overrides
            .map((o) => `${o.selector}(${specificity(o.selector).join(',')})`)
            .join(' / ') +
          ` 均 < 基础 ${baseSpec.join(',')}）`,
      )
    }
  }

  it('keeps [data-theme="dark"] foreground declarations readable on dark surfaces', () => {
    expect(darkContextFails, 'dark-context declarations below threshold').toEqual([])
  })

  it('keeps base foreground declarations readable on dark surfaces unless overridden or exempt', () => {
    expect(baseDarkFails, 'base declarations on dark surfaces below threshold').toEqual([])
  })

  it('keeps base foreground declarations readable on light surfaces (loose 3.0 + exemptions)', () => {
    expect(baseLightFails, 'base declarations on light surfaces below 3.0').toEqual([])
  })

  it('keeps same-file dark overrides specific enough to beat the scoped base rules', () => {
    expect(specificityFails, 'dark overrides with insufficient specificity').toEqual([])
  })
})
