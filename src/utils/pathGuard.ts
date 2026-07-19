/**
 * .chery/ 路径守卫：在感官 execute 前拦截对 .chery/ 的直接读写。
 *
 * 设计：tool middleware（agent/middleware/tool.ts doExecuteSense）在 handler 执行前
 *   调 checkCheryGuard；命中 .chery 路径段且感官非豁免（GUARD_EXEMPT）→ 返拦截文案，不执行。
 *
 * 与 envGuard 的关系：envGuard 是后置输出脱敏（执行后替换变量名），本守卫是前置拦截
 *   （执行前拒）。参考 envGuard 的"统一拦截层位置 + 注入说明"模式，语义不同。
 *
 * 豁免：install_skill（管家专用感官，合法写 .chery/skills/）。install_skill 只在管家
 *   senseGroup → 其他角色 senseTable 无此感官 → 双重隔离（调不到 + 写 .chery 被拦）。
 */
import { resolve, isAbsolute } from "path";

/** chery 根目录（与 config.ts 自动补全 *_dir 同一基准）。 */
function cheryRoot(): string {
  return resolve(process.env.CHERY_DIR || process.cwd(), ".chery");
}

/**
 * 判断目标字符串是否指向 .chery/ 下。
 * 匹配 .chery 作为路径段：(^|[\/\\])\.chery([\/\\]|$) —— 覆盖 .chery/x、./.chery/x、
 * /abs/.chery、x/.chery；不误伤 my.chery.txt。绝对路径额外 resolve 判定落 cheryRoot 下。
 */
export function isCheryPath(target: string): boolean {
  if (!target) return false;
  const t = target.trim();
  // 相对/绝对路径含 .chery 路径段
  if (/(^|[\/\\])\.chery([\/\\]|$)/.test(t)) return true;
  // 绝对路径 resolve 判定
  if (isAbsolute(t)) {
    try {
      const p = resolve(t);
      const root = cheryRoot();
      if (p === root || p.startsWith(root + "/") || p.startsWith(root + "\\")) return true;
    } catch {
      // resolve 失败 → 不拦
    }
  }
  return false;
}

/** 豁免名单：仅这些感官可写 .chery/（合法操作）。 */
export const GUARD_EXEMPT = new Set<string>(["install_skill"]);

/**
 * 从感官 args 提取路径参数（可能命中 .chery 的字段）。
 * execute_command 取 command（shell 字符串里可能含 .chery 路径）。
 */
export function extractSensePaths(name: string, args: Record<string, unknown>): string[] {
  switch (name) {
    case "write_file":
    case "read_file":
    case "search_codebase":
      return [typeof args.path === "string" ? args.path : ""];
    case "execute_command":
      return [typeof args.command === "string" ? args.command : ""];
    default:
      return [];
  }
}

/** 拦截文案（注入给 LLM，引导走管家角色）。 */
export const CHERY_GUARD_MESSAGE =
  ".chery/ 是系统配置目录（技能/插件/提示词/命令/数据库），不能直接读写。" +
  "安装或修改技能请用 spawn_role 派出「管家」角色（type: housekeeper），通过 install_skill 感官完成。";

/**
 * 守卫主入口。返回拦截文案（命中）或 null（放行）。
 * 豁免感官直接放行；否则提取路径参数，任一命中 isCheryPath 即拦。
 */
export function checkCheryGuard(name: string, args: Record<string, unknown>): string | null {
  if (GUARD_EXEMPT.has(name)) return null;
  const paths = extractSensePaths(name, args);
  for (const p of paths) {
    if (isCheryPath(p)) return CHERY_GUARD_MESSAGE;
  }
  return null;
}
