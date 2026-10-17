import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse, compileScript, compileTemplate } from 'vue/compiler-sfc'
import { useWindowDrag } from '../ui/useWindowDrag'
vi.mock('vue', async (importOriginal) => ({
  ...await importOriginal<typeof import('vue')>(),
  onMounted: vi.fn(),
  onUnmounted: vi.fn(),
}))
afterEach(() => vi.unstubAllGlobals())
const source = (name: string) => readFileSync(resolve(import.meta.dirname, '../ui', name), 'utf8')
describe('Manager internal plugin windows and login', () => {
  it('compiles all changed templates and controllers', () => {
    for (const name of ['App.vue', 'PluginsPanel.vue', 'PluginWindow.vue', 'PasswordField.vue']) {
      const { descriptor, errors } = parse(source(name))
      expect(errors).toEqual([])
      const script = compileScript(descriptor, { id: name })
      expect(
        compileTemplate({
          source: descriptor.template!.content,
          filename: name,
          id: name,
          compilerOptions: { bindingMetadata: script.bindings },
        }).errors,
      ).toEqual([])
    }
  })
  it('uses form submission from either login field and a non-submit show/hide control', () => {
    expect(source('App.vue')).toContain('@submit.prevent="login"')
    expect(source('App.vue')).toContain('type="submit"')
    const password = source('PasswordField.vue')
    expect(password).toContain(":type=\"visible ? 'text' : 'password'\"")
    expect(password).toContain('type="button"')
    expect(password).toContain('@click="visible = !visible"')
    expect(password).toContain('if (!value) visible.value = false')
    expect(source('manager.css')).toMatch(/\.manager\.manager-login\s*\{\s*width: min\(100%, 560px\);\s*min-height: 0;/)
  })
  it('keeps dynamic ownership, full pages and configuration inside child windows', () => {
    const app = source('App.vue'),
      panel = source('PluginsPanel.vue'),
      child = source('PluginWindow.vue')
    expect(app).not.toContain(':href="module.pagePath"')
    expect(app).toContain('已安装插件')
    expect(panel).not.toContain('readConfig(plugin.id)')
    expect(panel).not.toContain('<a ')
    expect(panel).toContain('open(plugin.id)')
    expect(child).toContain("module.manager.reason === 'resource_not_loaded'")
    expect(source('manager.css')).toMatch(/\.plugin-desktop\s*\{\s*position: fixed;\s*inset: 0;/)
    expect(child).toContain('item.pluginId === props.id')
    expect(child).toContain(':src="`${module.pagePath}?embedded=1`"')
    expect(child).toContain('v-show="selected === module.descriptor.id"')
    expect(child).toContain('readConfig(id)')
    expect(child).toContain('@click="saveConfig"')
    expect(child).toContain('@pointercancel="end"')
    expect(child).toContain('@lostpointercapture="end"')
    expect(panel).toContain('!pluginWindow.value.confirmDiscard()')
    expect(child).toContain('Object.values(dirtyModules.value).some(Boolean)')
    expect(child).toContain('config.dirty ||')
    expect(child).toContain('event.origin !== window.location.origin')
    expect(child).toContain('item.contentWindow === event.source')
  })
  it('drags with pointer capture, clamps to the visible area, ignores buttons and releases on cancel', () => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 })
    const drag = useWindowDrag()
    Object.assign(drag.position, { width: 600, height: 400 })
    const target = { closest: vi.fn(() => null) }
    const currentTarget = {
      setPointerCapture: vi.fn(),
    }
    const event = (x: number, y: number, id = 1) =>
      ({
        button: 0,
        pointerId: id,
        clientX: x,
        clientY: y,
        target,
        currentTarget,
        preventDefault: vi.fn(),
      }) as unknown as PointerEvent
    drag.start(event(100, 100))
    expect(currentTarget.setPointerCapture).toHaveBeenCalledWith(1)
    drag.move(event(150, 180))
    expect(drag.position).toEqual({ x: 66, y: 96, width: 600, height: 400 })
    drag.move(event(9000, 9000, 2))
    expect(drag.position).toEqual({ x: 66, y: 96, width: 600, height: 400 })
    drag.move(event(9000, 9000))
    expect(drag.position).toEqual({ x: 392, y: 392, width: 600, height: 400 })
    drag.move(event(-9000, -9000))
    expect(drag.position).toEqual({ x: 8, y: 8, width: 600, height: 400 })
    drag.end(event(0, 0))
    drag.move(event(300, 300))
    expect(drag.position).toEqual({ x: 8, y: 8, width: 600, height: 400 })
    target.closest.mockReturnValue({} as never)
    drag.start(event(0, 0))
    drag.move(event(100, 100))
    expect(drag.position).toEqual({ x: 8, y: 8, width: 600, height: 400 })
  })
  it('resizes with the pointer and keyboard, then restores after maximizing', () => {
    vi.stubGlobal('window', { innerWidth: 1200, innerHeight: 900 })
    const drag = useWindowDrag()
    Object.assign(drag.position, { x: 16, y: 16, width: 600, height: 400 })
    const pointer = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y,
      currentTarget: { setPointerCapture: vi.fn() }, preventDefault: vi.fn() }) as unknown as PointerEvent
    drag.resizeStart(pointer(100, 100))
    drag.move(pointer(180, 140))
    expect(drag.position).toEqual({ x: 16, y: 16, width: 680, height: 440 })
    drag.end(pointer(180, 140))
    drag.resizeKey({ key: 'ArrowRight', shiftKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent)
    expect(drag.position.width).toBe(720)
    drag.toggleMaximize()
    expect(drag.position).toEqual({ x: 8, y: 8, width: 1184, height: 884 })
    drag.resizeStart(pointer(100, 100))
    drag.move(pointer(200, 200))
    expect(drag.position.width).toBe(1184)
    drag.toggleMaximize()
    expect(drag.position).toEqual({ x: 16, y: 16, width: 720, height: 440 })
  })
})
