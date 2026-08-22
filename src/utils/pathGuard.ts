/**
 * .chery/ 路径守卫：在感官 execute 前拦截对 .chery/ 的直接读写。
 *
 * 设计：tool middleware（agent/middleware/tool.ts doExecuteSense）在 handler 执行前
 *   调 checkCheryGuard；命中 .chery 路径段且感官非豁免（GUARD_EXEMPT）→ 返拦截文案，不执行。
 *
 * 与 envGuard 的关系：envGuard 是后置输出脱敏（执行后替换变量名），本守卫是前置拦截
 *   （执行前拒）。参考 envGuard 的"统一拦截层位置 + 注入说明"模式，语义不同。
 *
 * 豁免：install_skill（配置管理核心角色 cheryNyxus 专用感官，合法写 .chery/skills/）。
 * install_skill 只在 cheryNyxus senseGroup（chery_nexus）→ 其他角色 senseTable 无此感官 →
 * 双重隔离（调不到 + 写 .chery 被拦）。
 * 另：配置管理核心角色（senseTable 含 install_skill）额外豁免 .chery/rule/ 的读写，用于生成/
 *   修改审批规则文件（与基准 base.yaml 深合并）。仅限该目录，.chery/ 其余路径仍拦。
 * 读放行：配置管理核心角色（senseTable 含 config_manage/install_skill，能力驱动）对 read_file/
 *   search_codebase 读 .chery/ 全树放行（按工具名旁路，allowConfigRead）——其定位就是读写全部配置；
 *   write_file/execute_command 仍拦（写走 config_manage/install_skill 结构化通道，execute_command
 *   的 cat .chery/config.yaml 会泄露非 .env 字面密钥、绕过结构化脱敏层）。
 * 注：config_manage 感官（结构化，无路径参数）天然不触发本守卫，无需加入 GUARD_EXEMPT。
 */
import { resolve, isAbsolute } from 'path'

/** chery 根目录（与 config.ts 自动补全 *_dir 同一基准）。 */
function cheryRoot(): string {
  return resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
}

/**
 * 判断目标字符串是否指向 .chery/ 下。
 * 匹配 .chery 作为路径段：(^|[\/\\\s])\.chery([\/\\]|$) —— 覆盖 .chery/x、./.chery/x、
 * /abs/.chery、x/.chery、以及 execute_command 命令参数位置的 .chery（如 `cat .chery/config.yaml`，
 * `.chery` 前是空格分隔符）；不误伤 my.chery.txt（`.chery` 前是字母）。
 * 绝对路径额外 resolve 判定落 cheryRoot 下。
 */
export function isCheryPath(target: string): boolean {
  if (!target) return false
  const t = target.trim()
  // 相对/绝对路径含 .chery 路径段（前导：行首 / 路径分隔符 / 空白分隔符）
  if (/(^|[\/\\\s])\.chery([\/\\]|$)/.test(t)) return true
  // 绝对路径 resolve 判定
  if (isAbsolute(t)) {
    try {
      const p = resolve(t)
      const root = cheryRoot()
      if (p === root || p.startsWith(root + '/') || p.startsWith(root + '\\')) return true
    } catch {
      // resolve 失败 → 不拦
    }
  }
  return false
}

/**
 * 判断目标字符串是否指向 .chery/rule/ 下（审批规则目录）。
 * 匹配 .chery/rule 作为路径段：(^|[\/\\])\.chery[\/\\]rule([\/\\]|$) —— 不误伤 .chery/rules.txt。
 * 绝对路径额外 resolve 判定落 <root>/.chery/rule 下。
 */
export function isRuleDirPath(target: string): boolean {
  if (!target) return false
  const t = target.trim()
  if (/(^|[\/\\])\.chery[\/\\]rule([\/\\]|$)/.test(t)) return true
  if (isAbsolute(t)) {
    try {
      const p = resolve(t)
      const root = resolve(cheryRoot(), 'rule')
      if (p === root || p.startsWith(root + '/') || p.startsWith(root + '\\')) return true
    } catch {
      // resolve 失败 → 不拦
    }
  }
  return false
}

/** 豁免名单：仅这些感官可写 .chery/（合法操作）。 */
export const GUARD_EXEMPT = new Set<string>(['install_skill'])

/**
 * 信息获取型命令动词：仅列目录/查询状态，不读取文件内容、不修改文件。
 * 命中任一即视为"信息获取"，对 .chery/ 的 execute_command 放行。
 */
const CHERY_INFO_COMMAND_RE =
  /(?:^|[\s;|&()])(?:ls|dir|find|stat|du|df|pwd|tree|test|where|which|get-childitem|get-item|get-location|get-acl|resolve-path|split-path|join-path|test-path)\b/i

/**
 * 读内容/修改型命令动词：读取配置文件内容或修改 .chery 文件，命中即拦（fail-closed）。
 * 覆盖 bash 与 PowerShell 常见命令；未知动词触碰 .chery 也走 fail-closed（见 isCheryInfoOnlyCommand）。
 */
const CHERY_READ_WRITE_COMMAND_RE =
  /\b(?:cat|more|less|head|tail|sed|awk|grep|egrep|fgrep|rg|vi|vim|nano|tee|echo|printf|cp|mv|rm|rmdir|mkdir|touch|truncate|dd|install|chmod|chown|tar|unzip|curl|wget|python|python3|node|npm|pnpm|bash|sh|source|exec|xargs|get-content|select-string|set-content|add-content|out-file|clear-content|remove-item|copy-item|move-item|new-item|icacls|takeown|set-acl)\b/i

/** 文件 I/O 重定向（排除 fd 重定向 2>&1 / 1>&2 / 2>&- 等 N[<>]&M 形式）。 */
function hasFileRedirection(command: string): boolean {
  const stripped = command.replace(/\d[<>]&(-|\d)|[0-9]?[<>]&-/g, '')
  return /[<>]/.test(stripped)
}

/**
 * execute_command 触碰 .chery/ 时的分级判定：
 *  - 纯信息获取（ls/dir/find/stat 等列目录、查询状态）→ true（放行）
 *  - 读取文件内容 / 修改 .chery / 动态执行 / 文件重定向 / 未知动词 → false（fail-closed 拦截）
 * 判据：不读配置内容（防泄密）、不改 .chery（防损坏）、不动态求值。
 */
export function isCheryInfoOnlyCommand(command: string): boolean {
  if (CHERY_READ_WRITE_COMMAND_RE.test(command)) return false
  if (hasFileRedirection(command)) return false
  if (/\$\(|`/.test(command)) return false
  return CHERY_INFO_COMMAND_RE.test(command)
}

/**
 * 从感官 args 提取路径参数（可能命中 .chery 的字段）。
 * execute_command 取 command（shell 字符串里可能含 .chery 路径）。
 */
export function extractSensePaths(name: string, args: Record<string, unknown>): string[] {
  switch (name) {
    case 'write_file':
    case 'read_file':
    case 'search_codebase':
      return [typeof args.path === 'string' ? args.path : '']
    case 'execute_command':
      return [typeof args.command === 'string' ? args.command : '']
    default:
      return []
  }
}

/** 拦截文案（注入给 LLM，引导交配置管理核心角色）。 */
export const CHERY_GUARD_MESSAGE =
  '.chery/ 是系统配置目录（技能/插件/提示词/命令/数据库）。' +
  '读取/修改 .chery 配置请使用 config_manage 感官（action="get"/"save"/"rollback"），' +
  '它可完整替代对配置文件的直接指令读写；禁止用 cat/type/grep/head 等读取配置内容、' +
  '或用 cp/mv/rm/echo 重定向等修改 .chery（会绕过脱敏并可能损坏配置）。' +
  '仅信息获取类命令（ls/dir/find/stat 等列目录、查询状态）放行。' +
  '安装或修改技能请用 spawn_role 派出「Cherry Nexus」角色（type: cheryNyxus）完成。'

export interface CheryGuardOptions {
  /**
   * 配置管理核心角色（senseTable 含 install_skill）：允许对 .chery/rule/ 读写（生成/修改审批规则）。
   * 仅限该目录；.chery/ 其余路径仍拦截。
   */
  allowRuleDir?: boolean
  /**
   * 配置管理核心角色（senseTable 含 config_manage/install_skill，能力驱动）：
   * read_file/search_codebase 读 .chery/ 全树放行（按工具名旁路，优先级在 allowRuleDir 与 isCheryPath 之前）。
   * write_file/execute_command 不受影响（写仍走 allowRuleDir + isCheryPath）。
   */
  allowConfigRead?: boolean
}

/**
 * 守卫主入口。返回拦截文案（命中）或 null（放行）。
 * 豁免感官直接放行；否则提取路径参数，任一命中 isCheryPath 即拦。
 * allowRuleDir：配置管理核心角色对 .chery/rule/ 的读写放行（全部命中路径都在规则目录），其余仍拦。
 * execute_command 触碰 .chery/：信息获取型命令（ls/dir/find/stat 等）放行，其余（读内容/修改/动态求值）拦截。
 */
export function checkCheryGuard(
  name: string,
  args: Record<string, unknown>,
  opts?: CheryGuardOptions,
): string | null {
  if (GUARD_EXEMPT.has(name)) return null
  // 配置管理核心角色读放行：read_file/search_codebase 按工具名旁路（.chery/ 全树可读），
  // 优先级在 allowRuleDir 与 isCheryPath 之前；write_file/execute_command 不受影响。
  if (opts?.allowConfigRead && (name === 'read_file' || name === 'search_codebase')) return null
  const paths = extractSensePaths(name, args).filter((p) => p.trim())
  // 配置管理核心角色写/读 .chery/rule/（审批规则）：全部命中路径都在规则目录 → 放行
  if (opts?.allowRuleDir && paths.length && paths.every((p) => isRuleDirPath(p))) return null
  for (const p of paths) {
    if (!isCheryPath(p)) continue
    // execute_command：信息获取型命令（ls/dir/find/stat 等列目录、查询状态）放行；
    // 读取配置内容 / 修改 .chery / 动态求值 / 未知动词 → fail-closed 拦截。
    if (name === 'execute_command' && isCheryInfoOnlyCommand(p)) continue
    return CHERY_GUARD_MESSAGE
  }
  return null
}
