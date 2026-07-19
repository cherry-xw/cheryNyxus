/**
 * 插件管理模块聚合入口。
 *
 * 插件 = 关联技能包（superpowers 风格），整仓存于 .chery/plugins/<name>/，loader 增量扫描并入
 * 可用 skills（命名空间 `<plugin>__<skill>`）。manifest (.chery-plugin.json) 记 source_url。
 */
export { registerPluginHandlers } from './import.js'
export { handlePluginsList, buildPluginInfo, listPluginSkills } from './list.js'
export { handlePluginsPreImportUrl, handlePluginsCheckUpdate } from './import.js'
export { readManifest, writeManifest, pluginDir, MANIFEST_FILE } from './registry.js'
export type { PluginManifest } from './registry.js'
