import { readFileSync, readdirSync, existsSync, statSync, openSync, readSync, closeSync, type Dirent } from "fs";
import { join, basename } from "path";
import yaml from "js-yaml";
import config from "@/utils/config.js";
import { logger } from "@/utils/logger/index.js";
import { estimateTokens } from "@/utils/token.js";

export interface SkillData {
  name: string;
  description: string;
  content: string;
  /** P1-5：自动触发条件描述（软提示，拼入 system prompt 供 LLM 判断何时触发） */
  trigger?: string;
  /** SKILL.md frontmatter 中其他用户自定义字段（保留全部，用于 JSON 序列化 token 估算）。 */
  extra?: Record<string, unknown>;
  /**
   * 来源插件名（undefined = `.chery/skills/` 下的独立 skill）。
   * 插件 skill 的 `name` 为命名空间形式 `<plugin>__<skill>`，避免与独立 skill / 其他插件冲突。
   */
  plugin?: string;
}

/** 规范化后的 skill 文件名（导入时统一改名至此）。 */
export const SKILL_FILE_NAME = "SKILL.md";

/** 大小写不敏感判断是否为 skill 定义文件（skill.md / SKILL.md / Skill.md 均匹配）。 */
export function isSkillFile(fileName: string): boolean {
  return fileName.toLowerCase() === "skill.md";
}

/** 计算技能对外暴露的有效名：插件 skill 加 `<plugin>__` 前缀做命名空间隔离。 */
function effectiveSkillName(rawName: string, plugin?: string): string {
  return plugin ? `${plugin}__${rawName}` : rawName;
}

/** skill 感官成功加载时写入模型上下文的完整文本（与 sense/skill 保持单一来源）。 */
export function formatSkillActivationContent(skill: Pick<SkillData, "name" | "content">): string {
  return `"${skill.name}"技能已激活。以下是完整指令，请严格遵守：\n\n${skill.content}`;
}

interface SkillMeta {
  name: string;
  description: string;
  content: string;
  trigger?: string;
  extra?: Record<string, unknown>;
}

/**
 * 解析 SKILL.md 文件的 frontmatter 和 content。
 * 保留全部 frontmatter 字段到 extra（不只取 name/description/trigger）——供 promptTokens
 * JSON 序列化时「全部纳入」使用。
 */
function parseSkillFrontmatter(
  content: string,
  defaultName: string,
): SkillMeta {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);

  if (!match) {
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
      trigger: undefined,
      extra: undefined,
    };
  }

  try {
    const frontmatter = (yaml.load(match[1]!) || {}) as Record<string, unknown>;
    const bodyContent = content.slice(match[0]!.length).trim();

    // 拆出已知字段到对应位置，其余保留为 extra（用户自定义字段）
    const { name: _n, description: _d, trigger: _t, ...rest } = frontmatter;

    return {
      name: (frontmatter.name as string) || defaultName,
      description: (frontmatter.description as string) || "",
      trigger: (frontmatter.trigger as string) || undefined,
      content: bodyContent,
      extra: Object.keys(rest).length > 0 ? rest : undefined,
    };
  } catch {
    return {
      name: defaultName,
      description: "",
      content: content.trim(),
      trigger: undefined,
      extra: undefined,
    };
  }
}

interface SkillLocation {
  /** skill 定义文件所在目录（含 SKILL.md）。 */
  skillDir: string;
  /** 目录名（frontmatter 无 name 时的兜底名）。 */
  defaultName: string;
  /** 来源插件名（undefined = 独立 skill）。 */
  plugin?: string;
}

interface SkillCatalogEntry {
  filePath: string;
  defaultName: string;
  name: string;
  description: string;
  trigger?: string;
  extra?: Record<string, unknown>;
  plugin?: string;
  size: number;
  mtimeMs: number;
}

const SKILL_HEADER_BYTES = 64 * 1024;
const catalogCache = new Map<string, SkillCatalogEntry>();

function readSkillHeader(filePath: string, size: number): string {
  const fd = openSync(filePath, "r");
  try {
    const length = Math.min(size, SKILL_HEADER_BYTES);
    const buffer = Buffer.alloc(length);
    const bytes = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytes).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function parseSkillHeader(content: string, defaultName: string): Omit<SkillMeta, "content"> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { name: defaultName, description: "" };
  try {
    const frontmatter = (yaml.load(match[1]!) || {}) as Record<string, unknown>;
    const { name: _n, description: _d, trigger: _t, ...rest } = frontmatter;
    return {
      name: (frontmatter.name as string) || defaultName,
      description: (frontmatter.description as string) || "",
      trigger: (frontmatter.trigger as string) || undefined,
      extra: Object.keys(rest).length > 0 ? rest : undefined,
    };
  } catch {
    return { name: defaultName, description: "" };
  }
}

/**
 * 在插件目录下发现 skill 根目录：优先 `<pluginDir>/skills/` 下直接子目录（superpowers 约定），
 * 否则扫 pluginDir 直接子目录。返回每个含 skill 文件的子目录。
 * 导出供 plugin/list.ts 复用，保证「列表展示」与「loader 加载」发现逻辑一致。
 */
export function discoverSkillRoots(pluginDir: string): SkillLocation[] {
  const roots: SkillLocation[] = [];
  const candidates: Array<{ dir: string }> = [];
  const skillsSub = join(pluginDir, "skills");
  const scanBase = existsSync(skillsSub) ? skillsSub : pluginDir;
  if (!existsSync(scanBase)) return roots;
  let entries: Dirent[];
  try {
    entries = readdirSync(scanBase, { withFileTypes: true });
  } catch {
    return roots;
  }
  for (const e of entries) {
    if (e.isDirectory()) candidates.push({ dir: join(scanBase, e.name) });
  }
  for (const { dir } of candidates) {
    try {
      const files = readdirSync(dir);
      if (files.some(isSkillFile)) {
        roots.push({ skillDir: dir, defaultName: basename(dir) });
      }
    } catch {
      // 单个目录读取失败跳过，不影响其他
    }
  }
  return roots;
}

/**
 * 枚举全部 skill 位置：`.chery/skills/<name>/`（独立）+ `.chery/plugins/<plugin>/...`（插件）。
 * 返回的 defaultName 尚未做命名空间处理；调用方按 plugin 决定是否前缀化。
 */
function scanSkillLocations(): SkillLocation[] {
  const locations: SkillLocation[] = [];
  const skillsDir = config.global.skills_dir;
  if (existsSync(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        locations.push({ skillDir: join(skillsDir, e.name), defaultName: e.name });
      }
    }
  }
  const pluginsDir = config.global.plugins_dir;
  if (existsSync(pluginsDir)) {
    for (const p of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!p.isDirectory()) continue;
      const pluginName = p.name;
      const pluginDir = join(pluginsDir, pluginName);
      for (const root of discoverSkillRoots(pluginDir)) {
        locations.push({ ...root, plugin: pluginName });
      }
    }
  }
  return locations;
}

/** 扫描轻量目录；未变化文件复用 frontmatter 缓存，不读取正文。 */
function scanSkillCatalog(): SkillCatalogEntry[] {
  const entries: SkillCatalogEntry[] = [];
  const alive = new Set<string>();
  for (const loc of scanSkillLocations()) {
    let files: string[];
    try { files = readdirSync(loc.skillDir); } catch { continue; }
    const skillFile = files.find(isSkillFile);
    if (!skillFile) continue;
    const filePath = join(loc.skillDir, skillFile);
    let stat: ReturnType<typeof statSync>;
    try { stat = statSync(filePath); } catch { continue; }
    alive.add(filePath);
    const cached = catalogCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.plugin === loc.plugin) {
      entries.push(cached);
      continue;
    }
    try {
      const header = parseSkillHeader(readSkillHeader(filePath, stat.size), loc.defaultName);
      const entry: SkillCatalogEntry = {
        filePath,
        defaultName: loc.defaultName,
        name: effectiveSkillName(header.name, loc.plugin),
        description: header.description,
        trigger: header.trigger,
        extra: header.extra,
        plugin: loc.plugin,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
      catalogCache.set(filePath, entry);
      entries.push(entry);
    } catch {
      // 单个损坏/不可读文件不影响目录中的其他技能。
    }
  }
  for (const key of catalogCache.keys()) if (!alive.has(key)) catalogCache.delete(key);
  return entries;
}

function loadCatalogEntry(entry: SkillCatalogEntry): SkillData | undefined {
  try {
    const meta = parseSkillFrontmatter(readFileSync(entry.filePath, "utf-8"), entry.defaultName);
    return {
      name: effectiveSkillName(meta.name, entry.plugin),
      description: meta.description,
      content: meta.content,
      trigger: meta.trigger,
      extra: meta.extra,
      plugin: entry.plugin,
    };
  } catch {
    return undefined;
  }
}

/**
 * 遍历全部 skill 位置（独立 + 插件），读取所有 SKILL.md/skill.md（实时，不缓存）。
 * 插件 skill 名加 `<plugin>__` 前缀做命名空间隔离。同名冲突 warn + 后者覆盖。
 * P1-4：原模块级缓存导致新增/改动不反映；改为实时遍历，保证热更可见（类比 sense reloadSenses）。
 */
function readAllSkills(): SkillData[] {
  const result: SkillData[] = [];
  for (const entry of scanSkillCatalog()) {
    const skill = loadCatalogEntry(entry);
    if (!skill) continue;
    const name = skill.name;

    if (result.some((s) => s.name === name)) {
      logger.warn(
        `[loadSkill] Warning: skill name "${name}" conflict, overwriting with latest`,
      );
    }
    result.push(skill);
  }

  return result;
}

/**
 * 实时读取单个 skill 数据（按对外有效名查找，含插件 skill 的命名空间名 `<plugin>__<skill>`）。
 * 遍历全部 location（独立 + 插件），命中即返回。未命中返回 undefined。
 */
export function getSkillRealtime(name: string):
  | { skill: SkillData; size: number; mtimeMs: number }
  | undefined {
  const entry = scanSkillCatalog().find((item) => item.name === name);
  if (entry) {
    const skill = loadCatalogEntry(entry);
    if (skill) return { skill, size: entry.size, mtimeMs: entry.mtimeMs };
  }

  return undefined;
}

/**
 * 集中计算 skill 的所有 token 字段（单一来源）。
 *
 * 字段语义：
 *   - nameDescTokens: 仅 name + description 的 token（不含 trigger、正文、其他附加内容）。
 *   - triggerTokens: 仅 trigger 行的 token（无 trigger 则 0）。
 *   - contentTokens: 仅正文 content 的 token。
 *   - promptTokens: JSON 序列化全字段（含 extra 用户自定义字段）的 token——按设计用作
 *     正文段的 token 计算（与 skill 感官调用结果注入上下文的体量一致）。
 *   - contextTokens: 激活该 skill 后预计新增的上下文 token（即 promptTokens），供前端
 *     发送窗口 `/` 命令菜单 hover 卡片展示「加载该 skill 的 token 消耗」；与正文段 token
 *     计算口径一致。
 *
 * **仅计算 SKILL.md 的部分 token 消耗，不包含其他附加拆分的技能内容**——
 *   不含 formatSkillActivationContent 激活包装前缀（注入到 skill 感官调用结果，归用户对话段）。
 *   system prompt `<skills>` 段的 XML 标签外壳由 computeContextBreakdown 用 estimateTokens(skills.text) 统一估算。
 */
export interface SkillTokenBreakdown {
  nameDescTokens: number;
  triggerTokens: number;
  contentTokens: number;
  promptTokens: number;
  contextTokens: number;
}

/**
 * 从单个 skill 目录加载完整 SkillData（直接读取 <folder>/<SKILL.md>，不走全局扫描）。
 * 供 plugin/list.ts 等需要按目录计算 token 的场景复用，与 peekSkillMeta（仅 frontmatter）互补。
 * plugin 提供时 name 加 `<plugin>__` 前缀（与 scanSkillCatalog 命名一致）。
 * 文件读取/解析失败返回 undefined（调用方决定回退策略）。
 */
export function loadSkillFromFolder(
  folder: string,
  opts?: { plugin?: string; defaultName?: string },
): SkillData | undefined {
  try {
    const files = readdirSync(folder);
    const skillFile = files.find(isSkillFile);
    if (!skillFile) return undefined;
    const defaultName = opts?.defaultName ?? basename(folder);
    const raw = readFileSync(join(folder, skillFile), "utf-8");
    const meta = parseSkillFrontmatter(raw, defaultName);
    return {
      name: effectiveSkillName(meta.name, opts?.plugin),
      description: meta.description,
      content: meta.content,
      trigger: meta.trigger,
      extra: meta.extra,
      plugin: opts?.plugin,
    };
  } catch {
    return undefined;
  }
}

export function computeSkillTokens(s: SkillData): SkillTokenBreakdown {
  const nameDescTokens = estimateTokens(`${s.name}\n${s.description}`);
  const triggerTokens = s.trigger
    ? estimateTokens(`触发条件: ${s.trigger}`)
    : 0;
  const contentTokens = estimateTokens(s.content);
  // promptTokens = JSON 序列化全字段（含 extra 用户自定义字段），按设计用作正文 token 计算。
  // 序列化按稳定顺序：name/description/trigger/content/extra 全部纳入。
  const promptJson = JSON.stringify({
    name: s.name,
    description: s.description,
    ...(s.trigger ? { trigger: s.trigger } : {}),
    content: s.content,
    ...(s.extra || {}),
  });
  const promptTokens = estimateTokens(promptJson);
  return {
    nameDescTokens,
    triggerTokens,
    contentTokens,
    promptTokens,
    contextTokens: promptTokens,
  };
}

/**
 * 获取所有 skill 的元数据（含预计算 token 字段）。
 *
 * 所有 token 字段集中在 computeSkillTokens 计算（单一来源），调用方直接复用，
 * 不再各自 estimateTokens。设计语义详见 computeSkillTokens 注释。
 *
 * 用途：skills.list RPC 返回给前端（contextTokens）+ system prompt `<skills>` 拼装 +
 * computeContextBreakdown.skills 段（estimateTokens(skills.text)）+ 正文段（promptTokens）等。
 */
/**
 * Skill 注入过滤器（per-role 技能组/插件组）。各字段 undefined = 该维度不限制（全部通过）。
 *   - skills：独立 skill 名白名单（仅作用于 plugin=undefined 的 skill）
 *   - plugins：插件名白名单（仅作用于带 plugin 字段的 skill）
 */
export interface SkillFilter {
  skills?: string[];
  plugins?: string[];
}

/** 判断单个 skill 是否通过 role 过滤（无 filter = 全部通过，向后兼容）。 */
export function matchSkillFilter(
  s: Pick<SkillData, "name" | "plugin">,
  filter?: SkillFilter,
): boolean {
  if (!filter) return true;
  if (s.plugin) {
    return filter.plugins === undefined || filter.plugins.includes(s.plugin);
  }
  return filter.skills === undefined || filter.skills.includes(s.name);
}

export function getSkillMetas(filter?: SkillFilter): Array<
  SkillData & SkillTokenBreakdown
> {
  return readAllSkills()
    .filter((s) => matchSkillFilter(s, filter))
    .map((s) => ({
      ...s,
      ...computeSkillTokens(s),
    }));
}

/** skills.list 分页参数（与 SkillsListRequestData 对齐）。 */
export interface SkillPaginationParams {
  page?: number;
  pageSize?: number;
  search?: string;
  plugin?: string;
}

/**
 * 分页版 getSkillMetas：先过滤再切片，仅对切片项计算 token（关键优化）。
 * 无分页参数时退化为全量返回（向后兼容 prompt builder 等内部调用）。
 */
export function getSkillMetasPaginated(
  params?: SkillPaginationParams & SkillFilter,
): { skills: Array<SkillData & SkillTokenBreakdown>; total: number; page: number; pageSize: number } {
  let all = scanSkillCatalog();

  // SkillFilter（per-role 白名单）
  all = all.filter((s) => matchSkillFilter(s, params));

  // search 过滤
  if (params?.search) {
    const q = params.search.toLowerCase();
    all = all.filter((s) =>
      s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q)
      || (s.trigger?.toLowerCase().includes(q) ?? false),
    );
  }

  // plugin 过滤
  if (params?.plugin !== undefined && params.plugin !== "*") {
    all = all.filter((s) => s.plugin === params.plugin);
  } else if (params?.plugin === undefined) {
    // undefined = 仅独立 skill（与 SkillsListRequestData 语义一致）
    all = all.filter((s) => !s.plugin);
  }
  // plugin === "*" = 全部，不过滤

  const total = all.length;

  // 无分页参数 → 返回全量（向后兼容）
  if (params?.page === undefined && params?.pageSize === undefined) {
    const skills = all.flatMap((entry) => {
      const skill = loadCatalogEntry(entry);
      return skill ? [{ ...skill, ...computeSkillTokens(skill) }] : [];
    });
    return { skills, total, page: 1, pageSize: total };
  }

  const pageSize = Math.min(params?.pageSize ?? 50, 200);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(params?.page ?? 1, 1), maxPage);
  const start = (page - 1) * pageSize;
  const sliced = all.slice(start, start + pageSize);

  // 仅对切片项计算 token
  const skills = sliced.flatMap((entry) => {
    const skill = loadCatalogEntry(entry);
    return skill ? [{ ...skill, ...computeSkillTokens(skill) }] : [];
  });
  return { skills, total, page, pageSize };
}

/**
 * 轻量名称列表：只读 name + plugin，不调 computeSkillTokens。
 * 供角色卡 TagSelect 下拉使用（不需要 token 数据）。
 */
export function getSkillNameList(): { skills: string[]; plugins: string[]; skillTokens: Record<string, number>; pluginTokens: Record<string, number> } {
  const all = scanSkillCatalog();
  const skills: string[] = [];
  const pluginSet = new Set<string>();
  const skillTokens: Record<string, number> = {};
  const pluginTokens: Record<string, number> = {};
  for (const s of all) {
    const systemTokens = estimateTokens(`${s.name}\n${s.description}`) + (s.trigger ? estimateTokens(`触发条件: ${s.trigger}`) : 0);
    if (s.plugin) {
      pluginSet.add(s.plugin);
      pluginTokens[s.plugin] = (pluginTokens[s.plugin] ?? 0) + systemTokens;
    } else {
      skills.push(s.name);
      skillTokens[s.name] = systemTokens;
    }
  }
  return { skills, plugins: [...pluginSet], skillTokens, pluginTokens };
}
