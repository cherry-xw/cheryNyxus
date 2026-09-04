import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

/**
 * 登录窗 2026-09 重置 v5（CyberWindow 一致壳 + bug 修复）设计契约：
 * 源码字符串断言（套件惯例，无 jsdom），锁定 CyberWindow 同款标题栏三键、
 * 密文默认使用原生 password input、is-light 黑光切换（无 :global(html:not(.dark))）、细长光束溢出、
 * 全直角、token 派生配色、双形态（native / 浮动）与状态机保留。
 */
describe('login surface redesign contract', () => {
  it('wires a CyberWindow-consistent shell with channel, signal and text controls', async () => {
    const source = await readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue'))

    expect(source).toContain('<div class="rift-panel" :class="{ \'is-error\': !!error }">')
    // CyberWindow 同款标题栏：AUTH channel 徽记 + signal + 文字三键 + 角括号
    expect(source).toContain('class="rift-channel">AUTH</span>')
    expect(source).toContain('class="rift-signal"')
    expect(source).toContain('aria-label="最小化"')
    expect(source).toContain('aria-label="关闭"')
    expect(source).toContain('cyber-corners')
    // 三键状态：卷帘最小化 / 最大化，每次打开复位
    expect(source).toContain('const minimized = ref(false)')
    expect(source).toContain('const maximized = ref(false)')
    expect(source).toContain('minimized.value = false')
    // v4 弹窗壳词汇不回归
    expect(source).not.toContain('rift-close')
    expect(source).not.toContain('CyberPanel')
  })

  it('keeps native and floating forms, ESC close and drag offset', async () => {
    const source = await readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue'))

    expect(source).toContain('data-desktop-hit')
    expect(source).toContain('@pointerdown="onTitlePointerDown"')
    expect(source).toContain("e.key === 'Escape'")
    // native 面不渲染内部标题栏（WindowFrame 承担）
    expect(source).toContain('v-if="!native"\n              class="rift-head"')
    expect(source).toContain('v-if="!native" type="button" class="btn btn--ghost"')
  })

  it('uses one native input and only switches its type when the lamp is toggled', async () => {
    const [lamp, dialog] = await Promise.all([
      readComponentSource(resolve('web/src/features/auth/LampPasswordField.vue')),
      readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue')),
    ])

    expect(lamp.match(/<input\b/g)).toHaveLength(1)
    expect(lamp).toContain('v-model="password"')
    expect(lamp).toContain(":type=\"lit ? 'text' : 'password'\"")
    expect(lamp).not.toContain(':value=')
    expect(lamp).not.toContain('{{ modelValue }}')
    expect(lamp).not.toContain('lamp-plain')
    expect(lamp).not.toContain('lamp-dots')
    expect(dialog).toContain("if (!local) return\n  lampLit.value = false\n  password.value = ''")
    expect(dialog).toContain("lampLit.value = false\n      password.value = ''\n      stopLight()")
    expect(dialog).toContain("password.value = isLocal.value ? '' : await auth.savedPasswordPlain()")
    // 亮灯时 input / caret 浮出光柱之上。
    expect(lamp).toContain('z-index: 3003;')
  })

  it('switches black light via theme-driven is-light class instead of :global hacks', async () => {
    const [dialog, lamp] = await Promise.all([
      readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue')),
      readComponentSource(resolve('web/src/features/auth/LampPasswordField.vue')),
    ])

    // theme store 驱动（跨窗同步），纯 scoped class
    expect(dialog).toContain('useThemeStore')
    expect(dialog).toContain("'is-light': isLight")
    expect(dialog).toContain(':theme="themeStore.theme"')
    expect(dialog).toContain('.is-light .light-cone')
    expect(lamp).toContain("'is-light': props.theme === 'light'")
    // 浅色显字与黑光对比；标题栏 z 3004 浮出光上，body 不创建 stacking context。
    expect(lamp).toContain('.is-light.is-lit .lamp-input')
    expect(dialog).toContain('background: linear-gradient(to left, var(--ink) 72%, transparent 98%)')
    expect(dialog).toContain('z-index: 3004;')
    expect(dialog).toContain('不设 z-index（避免创建 stacking context 困住密码 input）')
    // 不可靠的 :global(html:not(.dark)) 黑光 hack 不得回归
    expect(dialog).not.toContain(':global(html:not(.dark))')
    expect(lamp).not.toContain(':global(html:not(.dark))')
  })

  it('emits a slim long beam from the flashlight icon muzzle overflowing the window', async () => {
    const source = await readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue'))

    expect(source).toContain('function updateLight(')
    expect(source).toContain('requestAnimationFrame')
    // 光源 = 手电 icon 灯头口（按钮左缘 +14px）
    expect(source).toContain('switchElement')
    expect(source).toContain('swRect.left - stageRect.left + 14')
    // 锚点旋转摆动 + 手电整体轻微浮动
    expect(source).toContain('Math.sin(now * 0.0002)')
    expect(source).toContain('Math.sin(now * 0.005)')
    expect(source).toContain('Math.sin(now * 0.0013)')
    expect(source).toContain('Math.sin(now * 0.00017)')
    // 实体光柱：长度和粗细从输入井、按钮尺寸派生，右端锚 icon 灯头口。
    expect(source).toContain('--beam-len')
    expect(source).toContain('wellRect.width * 0.75')
    expect(source).toContain('linear-gradient(to left, var(--lamp-warm) 72%, transparent 98%)')
    expect(source).toContain('50% - var(--beam-half-far, 34px)')
    expect(source).toContain('50% + var(--beam-half-far, 34px)')
    expect(source).toContain('filter: blur(3px);')
    expect(source).toContain('mix-blend-mode: normal;')
    // 卷帘时暂停光束
    expect(source).toContain('watch(minimized')
    // 关灯/关闭即停帧
    expect(source).toContain('lampLit.value = false')
    expect(source).toContain('function stopLight(')
  })

  it('applies submit-first-disable (先选后测) while keeping click validation as fallback', async () => {
    const source = await readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue'))

    expect(source).toContain(':disabled="!canSubmit || busy"')
    expect(source).toContain('请先填写后端服务地址')
    expect(source).toContain('请先填写用户名')
    expect(source).toContain('请先填写密码')
    // 点击校验兜底保留
    expect(source).toContain('请输入后端服务地址')
    expect(source).toContain('请输入用户名与密码')
  })

  it('preserves the auth state machine end to end', async () => {
    const source = await readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue'))

    expect(source).toContain('auth.setServerAddress(base)')
    expect(source).toContain(
      'await auth.login(base, username.value, password.value, rememberPw.value)',
    )
    expect(source).toContain('await auth.savedPasswordPlain()')
    expect(source).toContain('auth.logout()')
    expect(source).toContain('disconnectLocal()')
    expect(source).toContain('emitAuthChanged({ serverAddress: base })')
    expect(source).toContain('void conn.reconnect()')
  })

  it('stays sharp-cornered with token-derived colors only', async () => {
    const [dialog, lamp] = await Promise.all([
      readComponentSource(resolve('web/src/features/auth/ServerLoginDialog.vue')),
      readComponentSource(resolve('web/src/features/auth/LampPasswordField.vue')),
    ])
    const all = `${dialog}\n${lamp}`

    // 全直角：不存在非 0 圆角
    expect(all).not.toMatch(/border-radius:\s*(?!0[;\s]|0;)[1-9]/)
    expect(all).toContain('border-radius: 0;')
    // 旧版玻璃风硬编码色不得回归；红色/绿色走 Element Plus 语义 token
    expect(all).not.toContain('#6d8bff')
    expect(all).not.toContain('#b06bff')
    expect(all).not.toContain('#e05a6a')
    expect(all).toContain('var(--el-color-danger)')
    // 深色暖黄光锚点（用户指定）
    expect(all).toContain('--lamp-warm')
  })

  it('unifies the native WindowFrame chrome with the CyberWindow vocabulary', async () => {
    const [frame, app] = await Promise.all([
      readComponentSource(resolve('web/src/features/desktop/WindowFrame.vue')),
      readComponentSource(resolve('web/src/App.vue')),
    ])

    // channel 徽记（可选 prop）+ signal + 文字三键；登录窗传 AUTH
    expect(frame).toContain('channel?: string')
    expect(frame).toContain('window-frame-channel')
    expect(frame).toContain('01 ▰▰▰')
    expect(frame).toContain("{{ maximized ? '❐' : '□' }}")
    expect(app).toContain('channel="AUTH"')
  })
})
