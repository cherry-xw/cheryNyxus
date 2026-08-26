/**
 * 行为权限展示层元数据与生效解析。
 * defaultPolicy / resolveEffectivePolicy 是后端 src/core/security/rolePolicy.ts
 * 的 defaultPolicy + mergePolicy 前端镜像，仅用于 UI 展示（模板卡片摘要、生效预览条）；
 * 真实裁决仍以服务端为准，后端模板默认值变更时需同步此处。
 */
import type { RolePermissionPolicyDto } from '@/application/backend/public'

export type PermissionTemplateValue = RolePermissionPolicyDto['template']

/** 模板默认策略：与后端 defaultPolicy 逐字段对应。 */
const TEMPLATE_DEFAULTS: Record<PermissionTemplateValue, {
  read: string
  write: string
  maxSandboxMode: NonNullable<NonNullable<RolePermissionPolicyDto['commands']>['maxSandboxMode']>
  mcpDefault: 'inherit' | 'allow' | 'ask' | 'deny'
  spawnEffect: 'inherit' | 'allow' | 'ask' | 'deny'
}> = {
  'read-only': {
    read: 'workspace',
    write: 'deny',
    maxSandboxMode: 'read-only',
    mcpDefault: 'deny',
    spawnEffect: 'deny',
  },
  'workspace-developer': {
    read: 'workspace',
    write: 'workspace',
    maxSandboxMode: 'workspace-write',
    mcpDefault: 'ask',
    spawnEffect: 'inherit',
  },
  trusted: {
    read: 'any',
    write: 'any-with-approval',
    maxSandboxMode: 'danger-full-access',
    mcpDefault: 'inherit',
    spawnEffect: 'inherit',
  },
  supervised: {
    read: 'workspace',
    write: 'any-with-approval',
    maxSandboxMode: 'danger-full-access',
    mcpDefault: 'ask',
    spawnEffect: 'ask',
  },
}

/** 模板卡片展示元数据（名称 / 一句话定位 / 维度摘要 / 风险级）。 */
export const TEMPLATE_CARDS: Array<{
  value: PermissionTemplateValue
  label: string
  /** 一句话定位 */
  tagline: string
  /** 按维度摘要（取模板默认值，紧凑文案） */
  summary: string
  /** 风险色点：0 绿 -> 3 红 */
  risk: 0 | 1 | 2 | 3
  /** 默认模板角标 */
  isDefault?: boolean
}> = [
  {
    value: 'read-only',
    label: '只读',
    tagline: '只能看，不能改任何东西',
    summary: '读 仅工作区 · 写 禁止 · 命令 只读沙箱 · MCP 拒绝 · 派遣 拒绝',
    risk: 0,
  },
  {
    value: 'workspace-developer',
    label: '工作区开发',
    tagline: '在工作区内自由干活',
    summary: '读 仅工作区 · 写 区内 · 命令 区内可写 · MCP 审核 · 派遣 允许',
    risk: 1,
  },
  {
    value: 'supervised',
    label: '全程监管',
    tagline: '默认审核，改动逐一确认',
    summary: '读 仅工作区 · 写 区外需审核 · 命令 完全访问 · MCP 审核 · 派遣 审核',
    risk: 2,
    isDefault: true,
  },
  {
    value: 'trusted',
    label: '受信任',
    tagline: '最少打扰，仍受 OS 沙箱兜底',
    summary: '读 任意路径 · 写 区外需审核 · 命令 完全访问 · MCP 放行 · 派遣 允许',
    risk: 3,
  },
]

export const READ_LABELS: Record<string, string> = {
  deny: '禁止',
  workspace: '仅工作区',
  any: '任意路径',
}
export const WRITE_LABELS: Record<string, string> = {
  deny: '禁止',
  workspace: '仅工作区内',
  'any-with-approval': '区内直写 · 区外需审核',
}
export const SANDBOX_LABELS: Record<string, string> = {
  'read-only': '只读沙箱',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问（经 OS 沙箱）',
}
export const EFFECT_LABELS: Record<string, string> = {
  inherit: '继承模板',
  allow: '允许',
  ask: '每次审核',
  deny: '拒绝',
}

export interface EffectivePermission {
  read: string
  write: string
  maxSandboxMode: string
  mcpDefault: string
  spawnEffect: string
  /** 各维度是否被显式覆盖（区别于模板继承） */
  customized: {
    read: boolean
    write: boolean
    maxSandboxMode: boolean
    mcpDefault: boolean
    spawnEffect: boolean
    shells: boolean
  }
  shells: Array<'bash' | 'powershell'>
}

/**
 * 模板 + 覆盖的合并结果（mergePolicy 镜像）：
 * 显式覆盖优先，缺省回落模板默认；mcp/spawn 的 inherit 解析为实际生效值
 * （未受信模板下未知 MCP -> 每次审核；inherit 派遣 -> 模板放行层级）。
 */
export function resolveEffectivePolicy(
  policy: RolePermissionPolicyDto | undefined,
): EffectivePermission {
  const template = policy?.template ?? 'supervised'
  const base = TEMPLATE_DEFAULTS[template]
  const read = policy?.filesystem?.read ?? base.read
  const write = policy?.filesystem?.write ?? base.write
  const maxSandboxMode = policy?.commands?.maxSandboxMode ?? base.maxSandboxMode
  const mcpDefault = policy?.mcp?.default ?? base.mcpDefault
  const spawnEffect = policy?.spawn?.effect ?? base.spawnEffect
  return {
    read,
    write,
    maxSandboxMode,
    // inherit 不改变决策，走未知工具监管：受信模板放行，其余模板审核
    mcpDefault: mcpDefault === 'inherit' ? (template === 'trusted' ? 'allow' : 'ask') : mcpDefault,
    spawnEffect: spawnEffect === 'inherit' ? 'allow' : spawnEffect,
    customized: {
      read: policy?.filesystem?.read !== undefined,
      write: policy?.filesystem?.write !== undefined,
      maxSandboxMode: policy?.commands?.maxSandboxMode !== undefined,
      mcpDefault: policy?.mcp?.default !== undefined,
      spawnEffect: policy?.spawn?.effect !== undefined,
      shells: policy?.commands?.shells !== undefined,
    },
    shells: policy?.commands?.shells ?? ['bash', 'powershell'],
  }
}
