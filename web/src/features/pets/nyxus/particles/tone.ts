import { smoothstep, mixHexColor } from './math'
import type { NyxusTone, NyxusParticleInput, NyxusCosmicMode } from './types'

const NEBULA_TONE: NyxusTone = {
  core: '#252a4d',
  dust: '#9aabd1',
  star: '#f8e4c8',
  accent: '#8299d8',
  spark: '#d9ecff',
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
    core: '#2c3154',
    dust: '#9ba9d4',
    star: '#f0d6df',
    accent: '#8eafe0',
    spark: '#f2edef',
  },
  singleRing: {
    core: '#302d50',
    dust: '#9caee0',
    star: '#f3dfc7',
    accent: '#739be8',
    spark: '#dcecff',
  },
  multiRing: {
    core: '#30284f',
    dust: '#aaa0dc',
    star: '#f2d5c8',
    accent: '#967fe2',
    spark: '#e4eaff',
  },
  barredSpiral: {
    core: '#302b4f',
    dust: '#a6a8d5',
    star: '#f6d4ba',
    accent: '#829ee4',
    spark: '#dcecff',
  },
  inclinedDisk: {
    core: '#24334f',
    dust: '#a0b8d4',
    star: '#f1d8bd',
    accent: '#77abe0',
    spark: '#dcf1ff',
  },
  merger: {
    core: '#382d50',
    dust: '#b0a9d4',
    star: '#f4d1bd',
    accent: '#a486df',
    spark: '#e2efff',
  },
  starburst: {
    core: '#403150',
    dust: '#c0a7c9',
    star: '#ffd1af',
    accent: '#d28bc6',
    spark: '#f7e7d6',
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
  if (input.serviceState === 'disconnected') return COSMIC_MODE_TONES.blackHole
  if (!input.connected || input.reaction === 'error') {
    return {
      core: '#41353f',
      dust: '#b8acb8',
      star: '#ffc9bd',
      accent: '#b9aaad',
      spark: '#eee8e6',
    }
  }
  if (!input.cosmicMode) return NEBULA_TONE
  const transition = Math.round(nyxusCosmicTransitionStrength(input.cosmicProgress) * 8) / 8
  return mixTone(NEBULA_TONE, COSMIC_MODE_TONES[input.cosmicMode], transition)
}
