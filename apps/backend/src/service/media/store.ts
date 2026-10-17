import { resolve } from 'node:path'
import { getSoulDb } from '@/db/index.js'
import { AssetStore } from './assetStore.js'

export function getAssetStore(): AssetStore {
  return new AssetStore(getSoulDb(), resolve(process.env.CHERY_DIR || process.cwd(), '.chery', 'assets'))
}
