/**
 * 导入错误分类（plugin / skill 共用）。
 * 后端 gitClone 已把代理/鉴权/网络失败归一为带特征的中文文案；
 * 这里按确定性规则映射到 5 类，给出贴合卡包导入语境的友好标题 + 处置建议。
 */
export type ImportErrorKind = "proxy" | "auth" | "git" | "network" | "generic";

export interface ImportErrorInfo {
  kind: ImportErrorKind;
  /** 短标题。 */
  title: string;
  /** 友好说明。 */
  detail: string;
  /** 可操作建议（缺省不显）。 */
  hint?: string;
  /** 原始后端文案（已截断净化）。 */
  raw: string;
}

/** 分类顺序即优先级：代理 > 鉴权 > git 缺失 > 网络 > 兜底。 */
const PATTERNS: Array<{ kind: ImportErrorKind; re: RegExp }> = [
  { kind: "proxy", re: /代理|proxy|connection timed out|failed to connect to|could not resolve host|etimedout|econnrefused/i },
  { kind: "auth", re: /鉴权|认证|authentication failed|permission denied|invalid username|forbidden|401|403|token/i },
  { kind: "git", re: /未安装 git|git cli|git_not_installed|未检测到 git/i },
  { kind: "network", re: /网络|fetch failed|enotfound|econnreset|network|offline/i },
];

const META: Record<ImportErrorKind, { title: string; detail: string; hint?: string }> = {
  proxy: { title: "代理连接失败", detail: "无法通过当前网络拉取仓库。", hint: "在下方「网络代理」填入地址后重试。" },
  auth: { title: "鉴权失败", detail: "用户名 / Token 无效或无权限。", hint: "检查凭据或重新输入 Token。" },
  git: { title: "缺少 git", detail: "未检测到 git CLI，Git 导入不可用。", hint: "请先安装 git 命令行。" },
  network: { title: "网络不通", detail: "无法访问该仓库地址。", hint: "检查网络连接或换用代理。" },
  generic: { title: "导入未完成", detail: "" },
};

function truncate(raw: string, max = 200): string {
  const s = raw.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 把后端错误文案归一为带分类的展示信息。 */
export function classifyImportError(rawMsg: string): ImportErrorInfo {
  const raw = truncate(rawMsg);
  for (const p of PATTERNS) {
    if (p.re.test(rawMsg)) {
      const meta = META[p.kind];
      return { kind: p.kind, title: meta.title, detail: meta.detail, hint: meta.hint, raw };
    }
  }
  return { kind: "generic", title: META.generic.title, detail: raw, raw };
}
