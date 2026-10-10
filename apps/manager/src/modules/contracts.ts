import type { ConfigRaw, BrainConfig, PresetConfig, RoleConfig } from '../../../backend/src/utils/config.js'
import type {
  ConfigApplyState,
  ConfigSaveResult,
} from '../../../../packages/protocol/src/configApply.js'
import type { SenseToolsResponseData } from '../../../backend/src/service/message/types.js'

export type { ConfigApplyState, ConfigSaveResult, BrainConfig, PresetConfig, RoleConfig }
export type ResourceKind = 'brains' | 'sense-groups' | 'presets'
export type BrainValue = BrainConfig
export type SenseGroupValue = string[]
/** Core preset fields, with optional shorthand for the leader's selections. */
export type PresetValue = Partial<PresetConfig> & { brain?: string; senseGroup?: string }
export interface ResourceValues {
  brains: BrainValue
  'sense-groups': SenseGroupValue
  presets: PresetValue
}
export interface CapabilityCatalog {
  brains: string[]
  senseGroups: string[]
  presets: string[]
  tools: SenseToolsResponseData['tools']
  baseRevision: string
}
export interface ResourceView<K extends ResourceKind = ResourceKind> {
  kind: K
  name: string
  value: ResourceValues[K]
  baseRevision: string
  apply: ConfigApplyState
  /** Keys never appear in value, including $ENV references. Omit key on edit to retain it. */
  secrets?: { keyConfigured: boolean }
}
export interface SaveResourceRequest<K extends ResourceKind = ResourceKind> {
  name: string
  originalName?: string
  value: ResourceValues[K]
  expectedBaseRevision: string
  requestId: string
}
export interface SaveResourceResult<K extends ResourceKind = ResourceKind> extends ResourceView<K> {
  saved: true
  save: ConfigSaveResult
}
export type ApiResult<T> = { data: T } | { error: { code: string; message: string } }
export interface ModuleRequest {
  method: string
  url: URL
  /** Parsed JSON after Manager Session/Origin authorization; no credentials accepted here. */
  body?: unknown
}
export interface ModuleResponse {
  status: number
  body: ApiResult<unknown>
}

export type CoreMethod =
  | keyof import('../../../../packages/protocol/src/ingress.js').IngressMethodMap
  | 'search.test'
  | 'search.settings.get'
  | 'search.settings.save'

  | 'prompts.preset.get'
  | 'prompts.preset.save'
  | 'config.preview'
  | 'config.get'
  | 'config.save'
  | 'config.apply.status'
  | 'brain.list'
  | 'sense.list'
  | 'sense.tools'
  | 'utils.models'
  | 'utils.modelRecommendation'

export interface CoreRpc {
  call(method: CoreMethod, params?: unknown): Promise<unknown>
  close?(): Promise<void> | void
}
export type CoreConfig = ConfigRaw & { baseRevision: string }
