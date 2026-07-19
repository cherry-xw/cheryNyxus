/**
 * 插件导入/更新/卸载后端（settings 「插件」tab）。
 *
 * 插件 = superpowers 风格的关联技能包（整仓一个 bundle）。GitHub URL 经 git clone（--depth 1）
 * 拉整仓 → 存入 .chery/plugins/<pluginName>/ + 写 .chery-plugin.json manifest（含 cloneUrl/branch/commitSha）。
 * loader 实时扫描插件目录，其 skill 以 `<plugin>__<skill>` 命名空间并入可用集合。
 *
 * 三步导入：preImportUrl（git ls-remote 取分支 + needsAuth/gitNotInstalled 探测）→ importUrl（按选定分支 clone
 * 到 staging 预览，含 existing 冲突）→ commit（落盘）。update 按 manifest.cloneUrl+branch 重新 clone 覆盖。
 * 鉴权：credentialId（凭据池）优先，否则 inline {username,password}（remember=true 入池）。密令后端解密，不回前端。
 *
 * 前置：系统须装 git CLI（硬性前提，缺失则 preImport/checkUpdate 返回 gitNotInstalled=true，不降级）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from "fs";
import { join } from "path";
import type { HandlerContext } from "../message/router.js";
import {
  Method,
  type PluginsPreImportUrlRequestData, type PluginsPreImportUrlResponseData,
  type PluginsImportUrlRequestData, type PluginsImportUrlResponseData,
  type PluginsCommitRequestData, type PluginsCommitResponseData,
  type PluginsCheckUpdateRequestData, type PluginsCheckUpdateResponseData,
  type PluginsCheckAllUpdatesRequestData, type PluginsCheckAllUpdatesResponseData,
  type PluginsCheckAllUpdatesFailure,
  type PluginsUpdateRequestData, type PluginsUpdateResponseData,
  type PluginsUninstallRequestData, type PluginsUninstallResponseData,
} from "../message/types.js";
import {
  createStaging, removeStaging, parseGithubUrl, sanitizeName,
  pluginDirExists, pluginsDir, removeCherySubdir, stagingRoot, NAME_PATTERN,
} from "../skill/importShared.js";
import {
  cloneRepo, listRemoteBranches, checkRemoteVersion,
  GitNotInstalledError,
} from "../skill/gitClone.js";
import { isGitAvailable, resolveAuth, resolveInlineAuth } from "../skill/credentials.js";
import { buildPluginInfo, listPluginSkills, handlePluginsList } from "./list.js";
import { readManifest, writeManifest, pluginDir } from "./registry.js";

interface PluginStagingMeta {
  repoDir: string;
  pluginName: string;
  sourceUrl: string;
  cloneUrl: string;
  branch: string;
  commitSha: string;
  commitDate: string;
}

function readPluginStaging(stagingId: string): PluginStagingMeta {
  const p = join(stagingRoot(), stagingId, "plugin-manifest.json");
  if (!existsSync(p)) throw new Error(`暂存 plugin-manifest 不存在（stagingId=${stagingId}），请重新导入`);
  return JSON.parse(readFileSync(p, "utf-8")) as PluginStagingMeta;
}

// isGitAvailable / resolveAuth / resolveInlineAuth 已抽到 ../skill/credentials.ts（plugin+skill 共用）

/** plugins.preImportUrl：解析 URL + 拉 branches。needsAuth/gitNotInstalled 探测。 */
export async function handlePluginsPreImportUrl(
  _ctx: HandlerContext,
  { url, credentialId, proxy }: PluginsPreImportUrlRequestData,
): Promise<PluginsPreImportUrlResponseData> {
  const parsed = parseGithubUrl(url);
  const suggestedName = sanitizeName(parsed.repo);
  const nameConflict = pluginDirExists(suggestedName);
  if (!(await isGitAvailable())) {
    return {
      gitNotInstalled: true,
      needsAuth: false,
      branches: [],
      owner: parsed.owner,
      repo: parsed.repo,
      suggestedName,
      nameConflict,
    };
  }
  const auth = credentialId ? resolveAuth(credentialId) : undefined;
  const { branches, defaultBranch, needsAuth } = await listRemoteBranches(parsed.gitUrl, auth, proxy);
  return {
    gitNotInstalled: false,
    needsAuth,
    branches,
    defaultBranch,
    owner: parsed.owner,
    repo: parsed.repo,
    suggestedName,
    nameConflict,
  };
}

/** plugins.importUrl：按选定分支 git clone 整仓 → staging 预览。 */
export async function handlePluginsImportUrl(
  _ctx: HandlerContext,
  data: PluginsImportUrlRequestData,
): Promise<PluginsImportUrlResponseData> {
  const parsed = parseGithubUrl(data.url);

  // 鉴权：credentialId 优先；否则 inline（remember=true 入池）-- 复用共享 resolveInlineAuth
  const { auth, savedCredentialId } = data.credentialId
    ? { auth: resolveAuth(data.credentialId), savedCredentialId: undefined }
    : resolveInlineAuth(parsed, {
        username: data.username,
        password: data.password,
        remember: data.remember,
        label: data.label,
      });

  const { id, dir } = createStaging();
  const dest = join(dir, "_raw");
  let clone: { dest: string; commitSha: string; commitDate: string };
  try {
    clone = await cloneRepo(parsed.gitUrl, dest, { branch: data.branch, auth, proxy: data.proxy });
  } catch (err) {
    removeStaging(id);
    if (err instanceof GitNotInstalledError) throw err;
    if ((err as { needsAuth?: boolean }).needsAuth) {
      throw new Error("Git 鉴权失败：用户名/Token 无效或无权限，请检查凭据后重试");
    }
    throw err;
  }
  // clone.dest 即 repoDir（git clone 不像 zipball 包一层 wrapper）
  // pluginName：data.pluginName 覆盖（preImport nameConflict=true 时前端改名）；否则用 repo 派生
  const pluginName = data.pluginName ? sanitizeName(data.pluginName) : sanitizeName(parsed.repo);
  if (!NAME_PATTERN.test(pluginName)) {
    throw new Error(`插件名 "${pluginName}" 非法（仅允许 [a-zA-Z0-9_-]），请修改文件夹名`);
  }
  const skills = listPluginSkills(pluginName, clone.dest);
  writeFileSync(
    join(dir, "plugin-manifest.json"),
    JSON.stringify({
      repoDir: clone.dest,
      pluginName,
      sourceUrl: data.url,
      cloneUrl: parsed.gitUrl,
      branch: data.branch,
      commitSha: clone.commitSha,
      commitDate: clone.commitDate,
    } satisfies PluginStagingMeta),
    "utf-8",
  );
  return {
    stagingId: id,
    pluginName,
    existing: pluginDirExists(pluginName),
    sourceUrl: data.url,
    branch: data.branch,
    commitSha: clone.commitSha,
    commitDate: clone.commitDate,
    savedCredentialId,
    skills,
  };
}

/** 落盘一个插件（从 repoDir 复制到 plugins_dir/<name> + 写 manifest）。existing+!overwrite 抛错。 */
function installPlugin(
  meta: PluginStagingMeta,
  overwrite: boolean,
  preserveInstalledAt?: string,
): NonNullable<ReturnType<typeof buildPluginInfo>> {
  if (pluginDirExists(meta.pluginName) && !overwrite) {
    throw new Error(`插件 "${meta.pluginName}" 已存在，需确认覆盖`);
  }
  const dest = pluginDir(meta.pluginName);
  if (existsSync(dest)) removeCherySubdir(dest);
  mkdirSync(pluginsDir(), { recursive: true });
  cpSync(meta.repoDir, dest, { recursive: true, force: true });
  const now = new Date().toISOString();
  writeManifest(meta.pluginName, {
    name: meta.pluginName,
    sourceUrl: meta.sourceUrl,
    cloneUrl: meta.cloneUrl,
    branch: meta.branch,
    commitSha: meta.commitSha,
    commitDate: meta.commitDate,
    installedAt: preserveInstalledAt ?? now,
    updatedAt: now,
    // 刚 clone 自分支 HEAD → 视为已检查且最新（latestSha = 当前 commitSha）
    lastCheckedAt: now,
    latestSha: meta.commitSha,
    latestDate: meta.commitDate,
    updateAvailable: false,
  });
  const info = buildPluginInfo(meta.pluginName);
  if (!info) throw new Error(`插件 "${meta.pluginName}" 落盘后读取失败`);
  return info;
}

/** plugins.commit：确认落盘。 */
export async function handlePluginsCommit(
  _ctx: HandlerContext,
  { stagingId, overwrite }: PluginsCommitRequestData,
): Promise<PluginsCommitResponseData> {
  const meta = readPluginStaging(stagingId);
  const plugin = installPlugin(meta, overwrite);
  removeStaging(stagingId);
  return { plugin };
}

/** plugins.checkUpdate：对比 manifest 当前 HEAD 与远端分支 HEAD。 */
export async function handlePluginsCheckUpdate(
  _ctx: HandlerContext,
  { name }: PluginsCheckUpdateRequestData,
): Promise<PluginsCheckUpdateResponseData> {
  if (!NAME_PATTERN.test(name)) throw new Error(`插件名 "${name}" 非法（仅允许 [a-zA-Z0-9_-]）`);
  const m = readManifest(name);
  if (!m) throw new Error(`插件 "${name}" 无 manifest，无法检查更新`);
  if (!(await isGitAvailable())) {
    return {
      gitNotInstalled: true,
      needsAuth: false,
      currentSha: m.commitSha,
      currentDate: m.commitDate,
      latestSha: "",
      lastUpgrade: m.updatedAt,
      updateAvailable: false,
    };
  }
  const parsed = m.cloneUrl ? null : parseGithubUrl(m.sourceUrl);
  const cloneUrl = m.cloneUrl || parsed!.gitUrl;
  const branch = m.branch || parsed!.branch || "main";
  const { latestSha, latestDate, needsAuth } = await checkRemoteVersion(cloneUrl, branch);
  // currentSha 缺失→视为有更新；否则比较 SHA
  const updateAvailable = !latestSha ? true : !m.commitSha ? true : m.commitSha !== latestSha;
  // 持久化检查结果到 manifest（list 透传供前端「上次检查/有更新」展示）
  writeManifest(name, {
    ...m,
    lastCheckedAt: new Date().toISOString(),
    latestSha,
    latestDate,
    updateAvailable,
    lastCheckError: undefined,
  });
  return {
    gitNotInstalled: false,
    needsAuth,
    currentSha: m.commitSha,
    currentDate: m.commitDate,
    latestSha,
    latestDate,
    lastUpgrade: m.updatedAt,
    updateAvailable,
  };
}

/**
 * plugins.checkAllUpdates：批量检查全部已安装插件，结果写入各自 manifest。
 * 单个失败（needsAuth / 网络错误 / git 缺失）计入 failed，不中断整体。
 */
export async function handlePluginsCheckAllUpdates(
  _ctx: HandlerContext,
  _data: PluginsCheckAllUpdatesRequestData,
): Promise<PluginsCheckAllUpdatesResponseData> {
  const dir = pluginsDir();
  const failed: PluginsCheckAllUpdatesFailure[] = [];
  if (!existsSync(dir)) return { checked: 0, updatesAvailable: 0, failed };
  if (!(await isGitAvailable())) {
    return { checked: 0, updatesAvailable: 0, failed: [{ name: "*", reason: "系统 git 未安装" }] };
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  let updatesAvailable = 0;
  for (const name of names) {
    const m = readManifest(name);
    if (!m) {
      failed.push({ name, reason: "manifest 缺失" });
      continue;
    }
    try {
      const parsed = m.cloneUrl ? null : parseGithubUrl(m.sourceUrl);
      const cloneUrl = m.cloneUrl || parsed!.gitUrl;
      const branch = m.branch || parsed!.branch || "main";
      const { latestSha, latestDate, needsAuth } = await checkRemoteVersion(cloneUrl, branch);
      if (needsAuth) {
        // 私有仓需鉴权 → 计失败，写 lastCheckError 让前端 marker
        const reason = "需鉴权（私有仓）";
        writeManifest(name, {
          ...m,
          lastCheckedAt: new Date().toISOString(),
          latestSha: m.latestSha,
          latestDate: m.latestDate,
          updateAvailable: m.updateAvailable,
          lastCheckError: reason,
        });
        failed.push({ name, reason });
        continue;
      }
      const avail = !latestSha ? true : !m.commitSha ? true : m.commitSha !== latestSha;
      writeManifest(name, {
        ...m,
        lastCheckedAt: new Date().toISOString(),
        latestSha,
        latestDate,
        updateAvailable: avail,
        lastCheckError: undefined,
      });
      if (avail) updatesAvailable++;
    } catch (err) {
      const reason = (err as { needsAuth?: boolean }).needsAuth
        ? "需鉴权（私有仓）"
        : err instanceof Error ? err.message : "未知错误";
      // 失败也尝试落最近检查时间 + reason（manifest 已存在）
      try {
        writeManifest(name, {
          ...m,
          lastCheckedAt: new Date().toISOString(),
          latestSha: m.latestSha,
          latestDate: m.latestDate,
          updateAvailable: m.updateAvailable,
          lastCheckError: reason,
        });
      } catch { /* ignore write failures */ }
      failed.push({ name, reason });
    }
  }
  return { checked: names.length, updatesAvailable, failed };
}

/** plugins.update：按 manifest.cloneUrl+branch 重新 clone 覆盖（保留插件名 identity + installedAt）。 */
export async function handlePluginsUpdate(
  _ctx: HandlerContext,
  { name }: PluginsUpdateRequestData,
): Promise<PluginsUpdateResponseData> {
  if (!NAME_PATTERN.test(name)) throw new Error(`插件名 "${name}" 非法（仅允许 [a-zA-Z0-9_-]）`);
  const m = readManifest(name);
  if (!m) throw new Error(`插件 "${name}" 无 manifest（source_url 未知），无法更新`);
  if (!pluginDirExists(name)) throw new Error(`插件 "${name}" 不存在`);
  if (m.cloneUrl && !m.branch) throw new Error(`插件 "${name}" manifest 缺 branch，无法更新（请卸载后重新导入）`);

  const parsed = m.cloneUrl ? null : parseGithubUrl(m.sourceUrl);
  const cloneUrl = m.cloneUrl || parsed!.gitUrl;
  const branch = m.branch || parsed!.branch || "main";

  const { id, dir } = createStaging();
  const dest = join(dir, "_raw");
  let clone: { dest: string; commitSha: string; commitDate: string };
  try {
    clone = await cloneRepo(cloneUrl, dest, { branch });
  } catch (err) {
    removeStaging(id);
    if (err instanceof GitNotInstalledError) throw err;
    if ((err as { needsAuth?: boolean }).needsAuth) {
      throw new Error("Git 鉴权失败：该仓库需凭据，更新暂不支持内联凭据，请用系统 git 凭据助手或卸载后重新导入");
    }
    throw err;
  }
  const meta: PluginStagingMeta = {
    repoDir: clone.dest,
    pluginName: name,
    sourceUrl: m.sourceUrl,
    cloneUrl,
    branch,
    commitSha: clone.commitSha,
    commitDate: clone.commitDate,
  };
  const plugin = installPlugin(meta, true, m.installedAt);
  removeStaging(id);
  return { plugin };
}

/** plugins.uninstall：删除整个插件目录。 */
export async function handlePluginsUninstall(
  _ctx: HandlerContext,
  { name }: PluginsUninstallRequestData,
): Promise<PluginsUninstallResponseData> {
  if (!NAME_PATTERN.test(name)) throw new Error(`插件名 "${name}" 非法（仅允许 [a-zA-Z0-9_-]）`);
  if (!pluginDirExists(name)) throw new Error(`插件 "${name}" 不存在`);
  removeCherySubdir(pluginDir(name));
  return { ok: true };
}

/** 注册插件管理 RPC handlers。list handler 亦在此注册。 */
export function registerPluginHandlers(router: import("../message/router.js").RpcRouter): void {
  router.register(Method.PLUGINS_LIST, handlePluginsList);
  router.register(Method.PLUGINS_PRE_IMPORT_URL, handlePluginsPreImportUrl);
  router.register(Method.PLUGINS_IMPORT_URL, handlePluginsImportUrl);
  router.register(Method.PLUGINS_COMMIT, handlePluginsCommit);
  router.register(Method.PLUGINS_CHECK_UPDATE, handlePluginsCheckUpdate);
  router.register(Method.PLUGINS_CHECK_ALL_UPDATES, handlePluginsCheckAllUpdates);
  router.register(Method.PLUGINS_UPDATE, handlePluginsUpdate);
  router.register(Method.PLUGINS_UNINSTALL, handlePluginsUninstall);
}
