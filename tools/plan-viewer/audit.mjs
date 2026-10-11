/** Shared, read-only plan consistency checks. No business completion inference. */
import * as auditFs from 'node:fs';
import auditPath from 'node:path';
import { findTables, extractLinks, stripMd, collectReferences, metadataValue, withoutFencedCode, createHeadingSlugger, splitTableRow } from './public/markdown.js';

export const PLAN_STATUSES = ['规划中', '执行中', '待综合验证', '待用户审批'];
export const TASK_STATUSES = ['未开始', '进行中', '阻塞', '已完成'];
const posix = (p) => p.replace(/\\/g, '/');
const statusWord = (s) => stripMd(s || '').split(/[。;；,，(（]/)[0].trim();
const inside = (root, target) => target === root || target.startsWith(root + auditPath.sep);

export function auditPlans({ planDir, repoRoot } = {}) {
  const root = auditPath.resolve(planDir || 'docs/plan');
  const project = auditPath.resolve(repoRoot || (auditPath.basename(root) === 'plan' && auditPath.basename(auditPath.dirname(root)) === 'docs' ? auditPath.join(root, '../..') : root));
  const issues = [], plans = [], cache = new Map();
  const relative = (file) => posix(auditPath.relative(root, file));
  const add = (code, severity, plan, file, line, message, expected, actual, action) => {
    issues.push({ code, severity, plan, path: relative(file), line: line || 1, message, expected: String(expected), actual: String(actual), action });
  };
  const kind = (p) => { try { const s = auditFs.lstatSync(p); return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'other'; } catch { return null; } };
  const safe = (p, boundary = project) => {
    try { return inside(auditFs.realpathSync(boundary), auditFs.realpathSync(p)); } catch { return false; }
  };
  const read = (p) => {
    if (cache.has(p)) return cache.get(p);
    if (kind(p) !== 'file' || !safe(p) || auditFs.statSync(p).size > 2 * 1024 * 1024) return null;
    const content = auditFs.readFileSync(p, 'utf8'); cache.set(p, content); return content;
  };
  const locate = (md, text) => Math.max(1, md.split('\n').findIndex((line) => line.includes(text)) + 1);
  const indexFile = auditPath.join(root, 'README.md');
  const index = read(indexFile);
  if (index === null) add('INDEX_MISSING', 'error', null, indexFile, 1, '计划总入口不可读取', '实际 README 文件（不超过 2 MiB）', kind(indexFile) || '不存在', '建立可读取的计划总入口。');
  const tables = findTables(index || '').filter((t) => t.columns.some((c) => stripMd(c) === '任务'));
  if (index !== null && !tables.length) add('INDEX_TABLE', 'error', null, indexFile, 1, '总入口没有任务表格', '含任务、状态列的表格', '未找到', '使用连续任务表格；空任务表允许存在。');
  const entries = [];
  for (const table of tables) {
    const columns = table.columns.map(stripMd), taskCol = columns.indexOf('任务'), stateCol = columns.indexOf('状态');
    if (stateCol < 0) add('INDEX_COLUMNS', 'error', null, indexFile, 1, '任务表格缺少状态列', '状态列', '无', '补充状态列并与各任务 README 一致。');
    for (const row of table.rows) {
      const cell = row[taskCol] || '', links = extractLinks(cell, collectReferences(index || ''));
      const line = locate(index || '', cell);
      let target = null;
      try {
        if (links.length === 1 && links[0].href && !/^(?:[a-z][\w+.-]*:|\/|#)/i.test(links[0].href)) target = auditPath.resolve(root, decodeURIComponent(links[0].href.split('#')[0]));
      } catch { /* Report invalid encoded links below. */ }
      if (!target || auditPath.dirname(auditPath.dirname(target)) !== root || auditPath.basename(target) !== 'README.md') {
        add('INDEX_TARGET', 'error', null, indexFile, line, '任务登记链接无效', '<任务目录>/README.md', cell || '空', '每行只链接一个直属任务 README，不使用目录链接或越界路径。'); continue;
      }
      const dir = auditPath.basename(auditPath.dirname(target));
      entries.push({ dir, name: links[0].text, indexStatus: statusWord(row[stateCol]), scope: row[columns.indexOf('范围')] || '', line });
    }
  }
  // Links outside parsed tables must not disappear behind a successful lint result.
  const indexedCells = new Set(tables.flatMap((t) => t.rows.map((r) => r.join('|'))));
  const rawLines = withoutFencedCode(index || '').split('\n');
  rawLines.forEach((line, i) => {
    if (!line.includes('|')) return;
    const links = extractLinks(line, collectReferences(index || '')).filter((l) => l.href && /(?:^|\/)README\.md(?:#|$)/i.test(l.href));
    if (!links.length) return;
    const normalized = splitTableRow(line).join('|');
    if (!indexedCells.has(normalized)) add('INDEX_ROW', 'error', null, indexFile, i + 1, '任务行不属于有效表格', '连续表格中的任务行', line.trim(), '删除表格内部空行，或为另一张表补齐表头。');
  });
  const diskDirs = [];
  if (kind(root) === 'directory') for (const entry of auditFs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'README.md') continue;
    if (entry.isDirectory()) diskDirs.push(entry.name);
    else add('ROOT_FILE', 'error', null, auditPath.join(root, entry.name), 1, '计划根存在未归位文件或链接', '仅 README 与任务目录', entry.name, '确认用途后移入任务或临时目录，符号链接不作为计划入口。');
  }
  const dirs = [...new Set([...entries.map((e) => e.dir), ...diskDirs])].sort();
  for (const dir of dirs) {
    const taskDir = auditPath.join(root, dir), readmeFile = auditPath.join(taskDir, 'README.md');
    const matches = entries.filter((e) => e.dir === dir), entry = matches[0];
    const md = kind(taskDir) === 'directory' ? read(readmeFile) : null, taskStatus = statusWord(metadataValue(md || '', '状态'));
    const plan = { dir, name: entry?.name || (md?.match(/^#\s+(.+)/m)?.[1] || dir), indexStatus: entry?.indexStatus || null, readmeStatus: taskStatus || null, scope: entry?.scope || '', registered: matches.length > 0, exists: md !== null, files: [], counts: { ledgerFiles: 0, taskFiles: 0, documents: 0, reachableDocuments: 0 } };
    plans.push(plan);
    if (!matches.length) add('PLAN_UNREGISTERED', 'error', dir, readmeFile, 1, '磁盘任务未登记', '总入口登记 1 次', '0 次', '在总入口登记真实状态，不能删除任务来隐藏遗漏。');
    if (matches.length > 1) add('PLAN_DUPLICATE', 'error', dir, indexFile, entry.line, '同一任务重复登记', '1 次', `${matches.length} 次`, '合并为一条任务记录。');
    if (md === null) { add('PLAN_MISSING', 'error', dir, readmeFile, 1, '任务 README 不存在或不可读取', '可读取的真实文件', kind(readmeFile) || '不存在', '恢复任务入口或确认任务已结束后同步登记；不自动删除。'); continue; }
    if (!PLAN_STATUSES.includes(taskStatus)) add('PLAN_STATUS', 'error', dir, readmeFile, locate(md, '状态'), '任务状态无效', PLAN_STATUSES.join(' / '), taskStatus || '未声明', '核对当前阶段并使用统一状态。');
    if (entry && entry.indexStatus !== taskStatus) add('STATUS_MISMATCH', 'error', dir, indexFile, entry.line, '入口与任务状态不同', `任务 README：${taskStatus || '未声明'}`, `总入口：${entry.indexStatus || '未声明'}`, '核实真实进度后同时更新入口与任务 README。');
    if (!metadataValue(md, '文档创建时间')) add('CREATED_MISSING', 'warning', dir, readmeFile, 1, '缺少创建时间', '原始时间或历史未知说明', '未声明', '按计划规范补录，不能使用本次时间冒充。');
    const checkpoints = withoutFencedCode(md).split('\n').filter((l) => /^#{2,6}\s+.*恢复(?:检查)?点/.test(l));
    if (checkpoints.length !== 1) add('RECOVERY_POINT', 'warning', dir, readmeFile, 1, '当前恢复检查点需要核对', '唯一当前恢复检查点', `${checkpoints.length} 个`, '合并为一个当前入口，替换过期下一步和授权说明。');
    const files = [];
    const walk = (folder) => {
      for (const e of auditFs.readdirSync(folder, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        if (e.name === 'out' && auditPath.basename(folder) === 'verify') {
          if (!e.isDirectory()) add('OUTPUT_DIRECTORY', 'error', dir, auditPath.join(folder, e.name), 1, '验证产物位置不是实际目录', 'verify/out 真实目录', e.isSymbolicLink() ? '符号链接' : '文件', '确认归属后恢复真实产物目录，不使用文件或链接隐藏资料。');
          continue;
        }
        const full = auditPath.join(folder, e.name);
        if (e.isSymbolicLink()) { add('SYMLINK', 'error', dir, full, 1, '计划资料使用符号链接', '计划内真实文件', '符号链接', '使用真实资料或明确链接，不读取符号链接目标。'); continue; }
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) files.push(full);
      }
    };
    walk(taskDir);
    const docs = files.filter((f) => f.endsWith('.md'));
    plan.counts.documents = docs.length;
    const taskFiles = docs.filter((f) => {
      if (f === readmeFile || auditPath.dirname(f) !== taskDir) return false;
      const header = (read(f) || '').split(/^## /m)[0];
      return metadataValue(header, '文档类型') === '小任务' || (metadataValue(header, '文档类型') !== '参考资料' && TASK_STATUSES.includes(statusWord(metadataValue(header, '状态'))));
    });
    plan.counts.taskFiles = taskFiles.length;
    for (const file of files) {
      const rel = posix(auditPath.relative(taskDir, file));
      if (/\.(?:log|tmp|bak|cache|pyc)$|(?:^|\/)\.DS_Store$/i.test(rel)) add('ARTIFACT_LOCATION', 'error', dir, file, 1, '运行产物未归位', 'verify/out 或任务临时目录', rel, '确认本任务归属后移动或清理，不以 Git 忽略代替清理。');
      if (/\.(?:mjs|cjs|js|ts|py|sh|ps1)$/i.test(rel) && !rel.startsWith('verify/')) add('SCRIPT_LOCATION', 'error', dir, file, 1, '临时脚本不在验证目录', 'verify/', rel, '可交接脚本移至 verify；长期代码迁入正式位置并更新引用。');
    }
    const graph = new Map();
    for (const file of docs) {
      const content = read(file);
      if (content === null) { add('DOCUMENT_READ', 'error', dir, file, 1, '文档不可读取', '不超过 2 MiB 的真实文件', '读取受限', '精简文档或恢复合法路径。'); continue; }
      const refs = collectReferences(content), edges = [];
      const citations = new Set([...content.matchAll(/^\s*(?:[-*]\s+)?\[([^\]]+)\]\s+(?:\[|https?:\/\/)/gm)].map((m) => m[1]));
      withoutFencedCode(content).split('\n').forEach((line, i) => {
        for (const link of extractLinks(line, refs)) {
          if (!link.href && citations.has(link.text)) continue;
          if (!link.href) { add('LINK_UNDEFINED', 'error', dir, file, i + 1, '引用链接未定义', '有效引用定义', link.text, '补充引用或改为有效链接。'); continue; }
          if (/^[a-z][\w+.-]*:/i.test(link.href) || link.href.startsWith('//')) continue;
          let target, anchor;
          try { const [part, hash] = link.href.split('#'); target = part ? auditPath.resolve(auditPath.dirname(file), decodeURIComponent(part)) : file; anchor = hash ? decodeURIComponent(hash) : ''; } catch { target = null; }
          if (!target || !inside(project, target) || /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(target)) { add('LINK_BOUNDARY', 'error', dir, file, i + 1, '本地引用越出可检查边界', '项目内明确资料', link.href, '使用项目内正式入口；第三方资料使用官方链接。'); continue; }
          if (!kind(target)) { add('LINK_MISSING', 'error', dir, file, i + 1, '引用目标不存在', link.href, '缺失', '更新到实际入口，或明确取消不再存在的引用。'); continue; }
          if (!safe(target)) { add('LINK_BOUNDARY', 'error', dir, file, i + 1, '引用目标通过链接越界', '项目内真实资料', link.href, '改用项目内真实入口。'); continue; }
          if (inside(taskDir, target) && target.endsWith('.md')) edges.push(target);
          if (anchor && target.endsWith('.md')) {
            const targetMd = read(target);
            if (targetMd !== null) {
              const slug = createHeadingSlugger(), anchors = new Set();
              for (const l of withoutFencedCode(targetMd).split('\n')) { const match = l.match(/^#{1,6}\s+(.+?)\s*#*\s*$/); if (match) anchors.add(slug(match[1])); }
              for (const m of targetMd.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) anchors.add(m[1]);
              if (!anchors.has(anchor)) add('LINK_ANCHOR', 'error', dir, file, i + 1, '引用章节不存在', `${relative(target)}#${anchor}`, '无此章节', '更新到当前章节，不使用旧阶段锚点。');
            }
          }
        }
      });
      graph.set(file, edges);
    }
    const reachable = new Set(), visit = (f) => { if (reachable.has(f)) return; reachable.add(f); for (const next of graph.get(f) || []) visit(next); };
    visit(readmeFile); plan.counts.reachableDocuments = docs.filter((f) => reachable.has(f)).length;
    for (const file of docs) {
      plan.files.push({ file: posix(auditPath.relative(taskDir, file)), reachable: reachable.has(file), task: taskFiles.includes(file) });
      if (!reachable.has(file)) add('DOCUMENT_UNREFERENCED', 'warning', dir, file, 1, '文档无法从任务入口到达', '有效入口或确认删除', '无入链', '核对用途，补入适当入口或清理本任务无用资料。');
    }
    const ledger = findTables(md).find((t) => t.columns.some((c) => stripMd(c) === '状态') && t.columns.some((c) => /任务|小任务|工作|部分|目标|交付/.test(stripMd(c))));
    if (!ledger && metadataValue(md, '计划形式') !== '单页') add('LEDGER_MISSING', 'warning', dir, readmeFile, 1, '没有可识别的小任务台账', '任务台账或单页计划标记', '无', '依据实际工作补齐台账；简单恢复任务可声明计划形式为单页。');
    if (ledger) {
      const cols = ledger.columns.map(stripMd), stateCol = cols.indexOf('状态'), idCol = cols.indexOf('ID'), depCol = cols.indexOf('依赖 ID');
      const refs = collectReferences(md), linkedTasks = new Set(), ids = new Map();
      for (const row of ledger.rows) {
        const rowState = statusWord(row[stateCol]), line = locate(md, row[stateCol] || '|');
        if (!TASK_STATUSES.includes(rowState)) add('TASK_STATUS', 'error', dir, readmeFile, line, '小任务台账状态无效', TASK_STATUSES.join(' / '), rowState, '保持完成事实准确，使用统一的小任务状态。');
        const links = row.flatMap((cell) => extractLinks(cell, refs)).filter((l) => l.href && !/^(?:[a-z][\w+.-]*:|\/|#)/i.test(l.href));
        const localTasks = [];
        for (const l of links) {
          let f; try { f = auditPath.resolve(taskDir, decodeURIComponent(l.href.split('#')[0])); } catch { continue; }
          if (auditPath.dirname(f) !== taskDir || f === readmeFile || !f.endsWith('.md')) continue;
          localTasks.push(f); linkedTasks.add(f);
          const child = read(f);
          if (child !== null) {
            const childState = statusWord(metadataValue(child, '状态'));
            if (childState && childState !== rowState) add('TASK_STATUS_MISMATCH', 'error', dir, f, locate(child, '状态'), '台账与小任务状态不同', `台账：${rowState}`, `文件：${childState}`, '核对实际进度，状态以总任务台账为维护位置。');
          }
          if (rowState === '已完成' && !/综合验证|用户验收/.test(row.join(' '))) add('COMPLETED_FILE', 'error', dir, f, 1, '完成项仍链接实施文件', '迁出有用事实后移除链接并删除', '仍有实施文档链接', '核对完成条件，迁出当前依赖事实后清理，不能误删设计资料。');
        }
        if (['进行中', '阻塞'].includes(rowState) && !localTasks.length && metadataValue(md, '计划形式') !== '单页') add('TASK_FILE_MISSING', 'error', dir, readmeFile, line, '正在执行的小任务没有文档入口', '当前小任务文件链接', '无', '补入实际执行文档；轻量任务可明确使用单页计划。');
        if (idCol >= 0) {
          const id = stripMd(row[idCol] || '');
          if (!id || ids.has(id)) add('TASK_ID', 'error', dir, readmeFile, line, '任务 ID 缺失或重复', '非空唯一 ID', id || '空', '为每项指定稳定且唯一的 ID。');
          ids.set(id, depCol < 0 ? [] : stripMd(row[depCol] || '').split(/[,，、\s]+/).filter((v) => v && v !== '无' && v !== '-'));
        }
      }
      plan.counts.ledgerFiles = linkedTasks.size;
      for (const f of taskFiles) if (!linkedTasks.has(f)) add('TASK_UNREGISTERED', 'error', dir, f, 1, '带状态的小任务未登记到台账', '台账链接', '未登记', '核对用途并登记；设计参考资料不应冒充执行任务。');
      const progress = metadataValue(md, '进度')?.match(/^(\d+)\s*\/\s*(\d+)/);
      const done = ledger.rows.filter((r) => statusWord(r[stateCol]) === '已完成').length;
      if (progress && (+progress[1] !== done || +progress[2] !== ledger.rows.length)) add('PROGRESS_MISMATCH', 'error', dir, readmeFile, locate(md, '进度'), '声明进度与台账统计不同', `${done}/${ledger.rows.length}`, `${progress[1]}/${progress[2]}`, '移除手写进度并从台账统计，或核对真实状态后同步。');
      const visiting = new Set(), visited = new Set();
      const dfs = (id) => {
        if (visiting.has(id)) { add('DEPENDENCY_CYCLE', 'error', dir, readmeFile, 1, '任务依赖形成循环', '可执行的依赖顺序', id, '拆开循环或明确独立的共同前置任务。'); return; }
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dep of ids.get(id) || []) { if (!ids.has(dep)) add('DEPENDENCY_MISSING', 'error', dir, readmeFile, 1, '依赖 ID 不存在', '台账内已有 ID', `${id} → ${dep}`, '更新依赖 ID；跨任务依赖使用正式链接和所需结果。'); else dfs(dep); }
        visiting.delete(id); visited.add(id);
      };
      for (const id of ids.keys()) dfs(id);
      if (taskStatus === '待用户审批' && ledger.rows.some((r) => statusWord(r[stateCol]) !== '已完成')) add('APPROVAL_UNFINISHED', 'error', dir, readmeFile, 1, '待审批计划仍有未完成事项', '全部台账已完成', '存在未完成项', '完成必要工作或退回真实阶段，不能只改状态绕过。');
    }
    if (taskStatus === '待用户审批') {
      const resultTables = docs.flatMap((file) => findTables(read(file) || '').filter((t) => t.columns.some((c) => stripMd(c) === '结论')).map((table) => ({ file, table })));
      if (!resultTables.length) add('APPROVAL_EVIDENCE', 'error', dir, readmeFile, 1, '待审批计划缺少可审阅验收材料', '含结论列的当前验证清单', '未找到', '保留验收文件至批准和删除；不把口头摘要冒充验证记录。');
      for (const { file, table } of resultTables) {
        const col = table.columns.map(stripMd).indexOf('结论');
        for (const row of table.rows) {
          const result = stripMd(row[col] || '');
          if (!['通过', '不适用'].includes(result)) add('APPROVAL_RESULT', 'error', dir, file, locate(read(file), row[0]), '待审批计划仍有未通过的验证', '通过或经用户确认的不适用', result || '空', '补齐真实验证，必要时退回综合验证或执行阶段。');
          if (result === '不适用') add('APPROVAL_EXCLUSION', 'warning', dir, file, locate(read(file), row[0]), '不适用范围需要确认', '用户明确同意的范围排除', row.join(' / '), '人工核对范围排除依据，脚本不推断用户批准。');
        }
      }
    }
  }
  for (const plan of plans) plan.issues = issues.filter((i) => i.plan === plan.dir);
  return { summary: { registered: entries.length, directories: diskDirs.length, documents: plans.reduce((n, p) => n + p.counts.documents, 0), errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length }, plans, issues };
}
