/**
 * Nyxus 粒子 canvas 绘制层（纯渲染，从 NyxusParticle.vue 提纯）。
 *
 * 仅负责"给定 ctx + particles + input → 绘制"，不持有 RAF/事件/响应式。
 * 自管三层离屏资源：glow 纹理缓存、shadow 蒙版、nebula 云团图层。
 * 绘制顺序/混合模式/globalAlpha 与原内联实现逐行一致，零视觉变更。
 */
import {
  contributesToNyxusFog,
  nyxusChromaticStrength,
  nyxusCloudColor,
  nyxusCosmicTransitionStrength,
  nyxusParticleCoreRadius,
  nyxusParticleHaloRadius,
  nyxusStarColor,
  nyxusStarHaloColor,
  resolveNyxusMode,
  toneForNyxus,
  type NyxusParticle,
  type NyxusParticleInput,
  type Vec2,
} from './nyxusParticleEngine'
import { clamp } from './math'

export interface NyxusRenderer {
  resizeCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D, extent: number): void
  render(
    context: CanvasRenderingContext2D,
    particles: NyxusParticle[],
    input: NyxusParticleInput,
    extent: number,
    statusDot: boolean,
    connectionStatus: string,
  ): void
  dispose(): void
}

export function createNyxusRenderer(): NyxusRenderer {
  const glowTextures = new Map<string, HTMLCanvasElement>()
  let shadowCanvas: HTMLCanvasElement | undefined
  let shadowContext: CanvasRenderingContext2D | null = null
  let nebulaCanvas: HTMLCanvasElement | undefined
  let nebulaContext: CanvasRenderingContext2D | null = null

  function colorWithAlpha(hex: string, alpha: number): string {
    const normalized = hex.replace('#', '')
    const value = Number.parseInt(normalized, 16)
    const red = (value >> 16) & 255
    const green = (value >> 8) & 255
    const blue = value & 255
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }

  function glowTexture(color: string): HTMLCanvasElement {
    const cached = glowTextures.get(color)
    if (cached) return cached
    const texture = document.createElement('canvas')
    texture.width = 32
    texture.height = 32
    const context = texture.getContext('2d')
    if (context) {
      const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16)
      gradient.addColorStop(0, colorWithAlpha(color, 1))
      gradient.addColorStop(0.14, colorWithAlpha(color, 0.88))
      gradient.addColorStop(0.42, colorWithAlpha(color, 0.36))
      gradient.addColorStop(0.72, colorWithAlpha(color, 0.09))
      gradient.addColorStop(1, colorWithAlpha(color, 0))
      context.fillStyle = gradient
      context.fillRect(0, 0, 32, 32)
    }
    glowTextures.set(color, texture)
    return texture
  }

  function resizeCanvas(
    canvas: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    extent: number,
  ): void {
    const ratio = Math.min(2.5, window.devicePixelRatio || 1)
    const width = Math.round(extent * ratio)
    if (canvas.width === width && canvas.height === width) return
    canvas.width = width
    canvas.height = width
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  function ensureShadowSurface(extent: number, ratio: number): CanvasRenderingContext2D | null {
    shadowCanvas ??= document.createElement('canvas')
    const width = Math.round(extent * ratio)
    if (shadowCanvas.width !== width || shadowCanvas.height !== width) {
      shadowCanvas.width = width
      shadowCanvas.height = width
      shadowContext = shadowCanvas.getContext('2d')
    }
    return shadowContext
  }

  function ensureNebulaSurface(extent: number, ratio: number): CanvasRenderingContext2D | null {
    nebulaCanvas ??= document.createElement('canvas')
    const width = Math.round(extent * ratio)
    if (nebulaCanvas.width !== width || nebulaCanvas.height !== width) {
      nebulaCanvas.width = width
      nebulaCanvas.height = width
      nebulaContext = nebulaCanvas.getContext('2d')
    }
    return nebulaContext
  }

  function fogMenuTargets(input: NyxusParticleInput): Vec2[] {
    const highlighted =
      input.highlightedMenuIndex >= 0 ? input.menuTargets[input.highlightedMenuIndex] : undefined
    if (!highlighted) return input.menuTargets
    return input.menuTargets.map((target, index) => {
      if (index === input.highlightedMenuIndex) return target
      return {
        x: target.x + (highlighted.x - target.x) * 0.6,
        y: target.y + (highlighted.y - target.y) * 0.6,
      }
    })
  }

  function renderReachFog(
    mask: CanvasRenderingContext2D,
    input: NyxusParticleInput,
    maskTexture: HTMLCanvasElement,
  ): void {
    const distance = input.pointerDistance
    if (!input.pointerActive || !Number.isFinite(distance) || distance >= input.size * 1.45) return

    const influence = 1 - clamp((distance - input.size * 0.35) / (input.size * 1.1), 0, 1)
    const direction = {
      x: input.pointer.x / Math.max(1, distance),
      y: input.pointer.y / Math.max(1, distance),
    }
    const normal = { x: -direction.y, y: direction.x }
    const reach = clamp(distance, input.size * 0.3, input.size * 0.98)
    const streams = [-1, 0, 1]

    for (const stream of streams) {
      for (let step = 0; step <= 8; step += 1) {
        const t = step / 8
        const eased = t * t * (3 - 2 * t)
        const curve =
          Math.sin(t * Math.PI) *
          input.size *
          (0.055 * stream + Math.sin(input.time * 0.31 + stream * 1.7) * 0.024)
        const width = input.size * (0.2 - t * 0.145) * (0.88 + Math.abs(stream) * 0.16)
        const x = direction.x * reach * eased + normal.x * curve
        const y = direction.y * reach * eased + normal.y * curve

        mask.globalAlpha = influence * (0.055 + (1 - t) * 0.045)
        mask.drawImage(maskTexture, x - width, y - width, width * 2, width * 2)
      }
    }
  }

  function renderShadowMask(
    context: CanvasRenderingContext2D,
    particles: NyxusParticle[],
    input: NyxusParticleInput,
    extent: number,
  ): void {
    const ratio = Math.min(2.5, window.devicePixelRatio || 1)
    const mask = ensureShadowSurface(extent, ratio)
    if (!mask || !shadowCanvas) return
    const maskTexture = glowTexture('#ffffff')

    mask.setTransform(ratio, 0, 0, ratio, 0, 0)
    mask.clearRect(0, 0, extent, extent)
    mask.save()
    mask.translate(extent / 2, extent / 2)
    mask.globalCompositeOperation = 'lighter'
    const renderMode = resolveNyxusMode(input)

    // 中心只保留小而克制的聚焦亮核，外围旋转光晕维持整体体积感。
    const centerRadius = input.size * 0.145
    mask.globalAlpha = 0.2
    mask.drawImage(maskTexture, -centerRadius, -centerRadius, centerRadius * 2, centerRadius * 2)
    mask.globalAlpha = 0.09
    for (let index = 0; index < 2; index += 1) {
      const angle = input.time * 0.12 + index * Math.PI
      const offset = input.size * 0.075
      const radius = input.size * 0.18
      const x = Math.cos(angle) * offset
      const y = Math.sin(angle * 1.3) * offset
      mask.drawImage(maskTexture, x - radius, y - radius, radius * 2, radius * 2)
    }

    mask.globalAlpha = 0.18
    for (const particle of particles) {
      if (!contributesToNyxusFog(particle)) continue
      const radius = input.size * (0.095 + particle.size * 0.045)
      mask.drawImage(maskTexture, particle.x - radius, particle.y - radius, radius * 2, radius * 2)
    }

    if (renderMode === 'reach') renderReachFog(mask, input, maskTexture)

    if (input.menuOpen && input.menuTargets.length > 0) {
      const targets = fogMenuTargets(input)
      mask.filter = `blur(${Math.max(3, input.size * 0.035)}px)`
      mask.lineCap = 'round'
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index]!
        const highlighted = index === input.highlightedMenuIndex
        mask.globalAlpha = highlighted ? 0.58 : 0.27
        mask.lineWidth = input.size * (highlighted ? 0.095 : 0.065)
        mask.strokeStyle = '#ffffff'
        mask.beginPath()
        mask.moveTo(0, 0)
        mask.quadraticCurveTo(-target.y * 0.16, target.x * 0.16, target.x, target.y)
        mask.stroke()
      }
      mask.filter = 'none'
    }
    mask.restore()

    mask.setTransform(ratio, 0, 0, ratio, 0, 0)
    mask.globalCompositeOperation = 'source-in'
    mask.globalAlpha = 1
    mask.fillStyle = toneForNyxus(input).core
    mask.fillRect(0, 0, extent, extent)
    mask.globalCompositeOperation = 'source-over'

    const spread = input.size * 0.07
    context.save()
    context.globalAlpha = 0.055
    context.filter = `blur(${Math.max(7, input.size * 0.085)}px)`
    context.drawImage(shadowCanvas, -spread, -spread, extent + spread * 2, extent + spread * 2)
    context.restore()
    context.save()
    context.globalAlpha = 0.085
    context.drawImage(shadowCanvas, 0, 0, extent, extent)
    context.restore()
  }

  /**
   * 中心在线状态点(仅主 pet,叠加于粒子之上,独立坐标系)。
   * core 2px 锚定不动(在线白/离线黑);halo 色略别于 core(在线暖金/离线暗紫),
   * 椭圆 rotate 自旋 + 双频扰动 → 明显旋转感。
   * connecting 明灭走 input.time 正弦;离线 halo 用 source-over(lighter 下暗色不可见)。
   */
  function renderStatusDot(
    context: CanvasRenderingContext2D,
    input: NyxusParticleInput,
    connectionStatus: string,
  ): void {
    // 双星有自身双心结构；状态点复用形态过渡曲线渐隐/渐显，避免切换时闪断。
    const binaryOpacity =
      input.cosmicMode === 'binary' ? 1 - nyxusCosmicTransitionStrength(input.cosmicProgress) : 1
    if (binaryOpacity <= 0.01) return
    const status = connectionStatus
    const breath = status === 'connecting' ? 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(input.time * 4)) : 1
    const isOffline = status === 'disconnected'
    // core 锚定 2px 不动;halo 色略别于 core(在线暖金/离线暗紫)+ 椭圆自旋 + 双频扰动 → 明显旋转感
    const coreColor = isOffline ? '#0b0b0c' : '#ffffff'
    const haloColor = isOffline ? '#2a1a30' : '#ffd9a0'
    const glow = glowTexture(haloColor)
    const haloRadius = 16
    const wobble = Math.sin(input.time * 2.3) * 0.07 + Math.sin(input.time * 5.1) * 0.035
    const haloR = haloRadius * (1 + wobble)
    context.save()
    context.rotate(input.time * 0.8)
    context.scale(1, 0.72)
    context.globalCompositeOperation = isOffline ? 'source-over' : 'lighter'
    context.globalAlpha = (isOffline ? 0.55 : 0.9) * breath * binaryOpacity
    context.drawImage(glow, -haloR, -haloR, haloR * 2, haloR * 2)
    context.restore()
    context.globalCompositeOperation = 'source-over'
    context.globalAlpha = breath * binaryOpacity
    context.fillStyle = coreColor
    context.beginPath()
    context.arc(0, 0, 2, 0, Math.PI * 2)
    context.fill()
  }

  function render(
    context: CanvasRenderingContext2D,
    particles: NyxusParticle[],
    input: NyxusParticleInput,
    extent: number,
    statusDot: boolean,
    connectionStatus: string,
  ): void {
    const ratio = Math.min(2.5, window.devicePixelRatio || 1)
    const tone = toneForNyxus(input)

    context.clearRect(0, 0, extent, extent)
    renderShadowMask(context, particles, input, extent)
    const nebula = ensureNebulaSurface(extent, ratio)
    if (nebula && nebulaCanvas) {
      nebula.setTransform(ratio, 0, 0, ratio, 0, 0)
      nebula.clearRect(0, 0, extent, extent)
      nebula.save()
      nebula.translate(extent / 2, extent / 2)

      // 云团在独立图层以内常规混合：中心不再被大量彩光加白，外围悬臂保持鲜明层次。
      nebula.globalCompositeOperation = 'source-over'
      const nebulaBreath =
        1 + Math.sin(input.time * 0.46) * 0.105 + Math.sin(input.time * 0.13 + 1.1) * 0.025
      const gathering = clamp((1.13 - nebulaBreath) / 0.26, 0, 1)
      for (const particle of particles) {
        if (!contributesToNyxusFog(particle)) continue
        const color = nyxusCloudColor(particle, input.time, gathering)
        const radius = input.size * (0.165 + particle.size * 0.09)
        const pulse = 0.78 + Math.sin(input.time * 0.22 + particle.phase) * 0.14
        const centerDensity =
          1 - clamp(Math.hypot(particle.x, particle.y) / (input.size * 0.38), 0, 1)
        const centerFade = 0.13 + (1 - centerDensity) * 0.87
        const colorLift = 0.9 + gathering * 0.2
        const spreadShade = 0.84 + (1 - gathering) * 0.12
        nebula.globalAlpha = pulse * colorLift * spreadShade * centerFade * 0.13
        const cloudGlow = glowTexture(color)
        nebula.drawImage(
          cloudGlow,
          particle.x - radius,
          particle.y - radius,
          radius * 2,
          radius * 2,
        )
      }
      nebula.restore()

      // 云团作为单一图层落到主画布，实际合成透明度硬性不超过 80%。
      context.save()
      context.globalAlpha = 0.8
      context.drawImage(nebulaCanvas, 0, 0, extent, extent)
      context.restore()
    }

    context.save()
    context.translate(extent / 2, extent / 2)

    for (let brightness = 0; brightness <= 1; brightness += 1) {
      context.fillStyle = colorWithAlpha(tone.accent, brightness === 0 ? 0.1 : 0.18)
      context.beginPath()
      for (const particle of particles) {
        if (particle.brightness !== brightness) continue
        const radius = nyxusParticleHaloRadius(particle)
        context.moveTo(particle.x + radius, particle.y)
        context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
      }
      context.fill()
    }

    for (let brightness = 0; brightness <= 1; brightness += 1) {
      context.fillStyle = colorWithAlpha(tone.spark, brightness === 0 ? 0.66 : 0.86)
      context.beginPath()
      for (const particle of particles) {
        if (particle.brightness !== brightness) continue
        const radius = nyxusParticleCoreRadius(particle) * 1.12
        context.moveTo(particle.x + radius, particle.y)
        context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
      }
      context.fill()
    }

    context.globalCompositeOperation = 'lighter'
    const glowCells = new Map<string, number>()
    const glowCellSize = Math.max(3, (input.size / 112) * 4)
    for (const particle of particles) {
      const chromaticStrength = nyxusChromaticStrength(particle, input.time)
      if (particle.brightness < 2 && chromaticStrength <= 0) continue
      const cellKey = `${Math.floor(particle.x / glowCellSize)}:${Math.floor(particle.y / glowCellSize)}`
      const cellCount = glowCells.get(cellKey) ?? 0
      if (cellCount >= 3) continue
      glowCells.set(cellKey, cellCount + 1)
      const twinkle =
        0.52 + Math.sin(input.time * (0.65 + particle.orbit * 0.45) + particle.phase) * 0.32
      const highlighted =
        input.highlightedMenuIndex >= 0 &&
        (particle.armSlot === input.highlightedMenuIndex || particle.armRank < 0.72)
          ? 1.35
          : 1
      const alpha = clamp(twinkle * highlighted, 0.16, 1)
      if (particle.brightness >= 2) {
        const radius = nyxusParticleHaloRadius(particle) * particle.birthT
        const fade = (1 - particle.explosionT) * particle.birthT
        context.globalAlpha = alpha * (particle.brightness === 3 ? 0.3 : 0.16) * fade
        const starGlow = glowTexture(nyxusStarHaloColor(particle))
        context.drawImage(
          starGlow,
          particle.x - radius,
          particle.y - radius,
          radius * 2,
          radius * 2,
        )
      }
      if (chromaticStrength > 0) {
        const radius = 2.25 + particle.size * 0.7
        context.globalAlpha = alpha * chromaticStrength * 0.36
        const sparkGlow = glowTexture(tone.star)
        context.drawImage(
          sparkGlow,
          particle.x - radius,
          particle.y - radius,
          radius * 2,
          radius * 2,
        )
      }
    }
    // 恒星爆炸闪光环:径向扩张 + alpha 中峰(sin)渐隐
    for (const particle of particles) {
      if (particle.explosionT <= 0) continue
      const progress = particle.explosionT
      const ringRadius = (4 + particle.size * 2.2) * (0.4 + progress * 1.6)
      context.globalAlpha = Math.sin(progress * Math.PI) * 0.55
      const starGlow = glowTexture(nyxusStarHaloColor(particle))
      context.drawImage(
        starGlow,
        particle.x - ringRadius,
        particle.y - ringRadius,
        ringRadius * 2,
        ringRadius * 2,
      )
    }
    context.globalCompositeOperation = 'source-over'
    for (const particle of particles) {
      if (particle.brightness < 2) continue
      const fade = (1 - particle.explosionT) * particle.birthT
      if (fade <= 0) continue
      const radius = nyxusParticleCoreRadius(particle) * particle.birthT
      context.globalAlpha = (particle.brightness === 3 ? 1 : 0.92) * fade
      context.fillStyle = nyxusStarColor(particle)
      context.beginPath()
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
      context.fill()
    }
    context.globalAlpha = 0.96
    context.beginPath()
    for (const particle of particles) {
      const chromaticStrength = nyxusChromaticStrength(particle, input.time)
      if (chromaticStrength <= 0) continue
      context.globalAlpha = chromaticStrength * 0.96
      context.fillStyle = tone.star
      const radius = nyxusParticleCoreRadius(particle) * (1 + chromaticStrength * 0.08)
      context.moveTo(particle.x + radius, particle.y)
      context.arc(particle.x, particle.y, radius, 0, Math.PI * 2)
      context.fill()
      context.beginPath()
    }
    context.restore()
    context.globalAlpha = 1
    context.globalCompositeOperation = 'source-over'
    if (statusDot) {
      context.save()
      context.translate(extent / 2, extent / 2)
      renderStatusDot(context, input, connectionStatus)
      context.restore()
    }
  }

  function dispose(): void {
    glowTextures.clear()
    shadowCanvas = undefined
    shadowContext = null
    nebulaCanvas = undefined
    nebulaContext = null
  }

  return { resizeCanvas, render, dispose }
}
