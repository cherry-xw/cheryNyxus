import { smoothstep, mixHexColor } from './math'
import type { NyxusTone, NyxusParticleInput, NyxusCosmicMode } from './types'

const NEBULA_TONE: NyxusTone = {
  core: '#333451',
  dust: '#aeb8d2',
  star: '#fff0c1',
  accent: '#9daed3',
  spark: '#dbe9ff',
}

const COSMIC_MODE_TONES: Record<NyxusCosmicMode, NyxusTone> = {
  blackHole: {
    core: '#302d4a',
    dust: '#aeb0ce',
    star: '#d9e9ff',
    accent: '#b8b1c4',
    spark: '#f1ecef',
  },
  pulsar: {
    core: '#2c304b',
    dust: '#a8b8d0',
    star: '#d9e9ff',
    accent: '#b4c1c3',
    spark: '#f2eeee',
  },
  binary: {
    core: '#393244',
    dust: '#c4b4aa',
    star: '#fff0c1',
    accent: '#d3c29f',
    spark: '#f3eee8',
  },
  supernova: {
    core: '#41333c',
    dust: '#cfb7a9',
    star: '#ffc58e',
    accent: '#d4c199',
    spark: '#f5f0e7',
  },
  tidalRings: {
    core: '#332d4a',
    dust: '#b5aecb',
    star: '#e0c9ff',
    accent: '#aec0b9',
    spark: '#f2edef',
  },
}

/** 特殊宇宙形态的统一淡入淡出强度；0/1 为静态星云，中央区为完整形态。 */
export function nyxusCosmicTransitionStrength(progress: number): number {
  const enter = smoothstep(0, 0.22, progress)
  const leave = 1 - smoothstep(0.72, 1, progress)
  return enter * leave
}

function mixTone(from: NyxusTone, to: NyxusTone, amount: number): NyxusTone {
  return {
    core: mixHexColor(from.core, to.core, amount),
    dust: mixHexColor(from.dust, to.dust, amount),
    star: mixHexColor(from.star, to.star, amount),
    accent: mixHexColor(from.accent, to.accent, amount),
    spark: mixHexColor(from.spark, to.spark, amount),
  }
}

export function toneForNyxus(input: NyxusParticleInput): NyxusTone {
  if (!input.connected || input.reaction === 'error') {
    return {
      core: '#41353f',
      dust: '#b8acb8',
      star: '#ffc9bd',
      accent: '#b9aaad',
      spark: '#eee8e6',
    }
  }
  if (input.working || input.action === 'chatting') {
    return {
      core: '#30324a',
      dust: '#adb8d0',
      star: '#d9e9ff',
      accent: '#afc2c3',
      spark: '#f1ecee',
    }
  }
  if (!input.cosmicMode) return NEBULA_TONE
  const transition = Math.round(nyxusCosmicTransitionStrength(input.cosmicProgress) * 8) / 8
  return mixTone(NEBULA_TONE, COSMIC_MODE_TONES[input.cosmicMode], transition)
}
