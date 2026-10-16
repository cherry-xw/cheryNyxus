import type { IngressRequestIdentity } from '@chery/plugin-api'

/** Plugin requests cannot obtain Backend shell/configuration privileges. */
export function isManagedRequest(identity?: Readonly<IngressRequestIdentity>): boolean {
  return identity?.source === 'plugin'
}

const denied = new Set([
  'execute_command', 'read_file', 'write_file', 'search_codebase',
  'config_manage', 'install_skill', 'role_acceptance',
  'send_to_child',
])

export function managedToolDenied(name: string, identity?: Readonly<IngressRequestIdentity>): boolean {
  return isManagedRequest(identity) && (denied.has(name) || name.startsWith('mcp__'))
}

export function assertManagedToolAllowed(name: string, identity?: Readonly<IngressRequestIdentity>): void {
  if (managedToolDenied(name, identity)) {
    throw Object.assign(new Error('受管请求禁止访问 Backend 命令、文件、配置或 MCP；请使用 managed_app 在所属应用容器内操作文件和命令。'), {
      code: 'APP_ACCESS_DENIED',
    })
  }
}
