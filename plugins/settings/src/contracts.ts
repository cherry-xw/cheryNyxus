import type { ConfigRaw, PresetConfig } from '@chery/plugin-api'
import type { ConfigApplyState, ConfigSaveResult } from '../../../packages/protocol/src/configApply.js'
import type { SettingsCatalog, SettingsResourceKind } from '../../../packages/protocol/src/settings.js'
export type ResourceKind = SettingsResourceKind
export type PresetValue = Partial<PresetConfig> & { brain?: string; senseGroup?: string }
export type CoreConfig = ConfigRaw & { baseRevision: string }
export type CapabilityCatalog = SettingsCatalog
export interface CoreRpc { call(method: string, params: unknown): Promise<unknown> }
export interface ResourceView {
  kind: ResourceKind
  name: string
  value: ConfigRaw['llm']['brain'][string] | string[] | PresetValue
  baseRevision: string
  apply: ConfigApplyState
  secrets?: { keyConfigured: boolean }
}
export interface SaveResourceResult extends ResourceView { saved: true; save: ConfigSaveResult }
