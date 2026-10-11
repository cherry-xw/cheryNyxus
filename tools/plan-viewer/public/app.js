/* Plan Viewer 前端逻辑 —— 原生 JS，无构建、无外部依赖
 * 视图层级：#/ 总览、#/issues 差异、#/plan/<dir> 任务详情、#/file/<path> 文档
 */

import { extractLinks, collectReferences, isReferenceDefinition, createHeadingSlugger, splitTableRow, stripMd } from './markdown.js';
import { posixJoin, documentHref, parseRoute, createNavigation, loadCurrentFile } from './navigation.js';
import { filterPlans, filterIssues } from './filters.js';

const $app = document.getElementById('app');
const $sidebar = document.getElementById('sidebar');
const $refreshState = document.getElementById('refresh-state');
const state = {
  data: null,
  error: null,
  refreshError: null,
  refreshing: false,
  auditFilter: 'all',
  issueQuery: '',
  planQuery: '',
  planStatus: 'all',
  attentionOnly: false,
  sidebarOpen: false,
};
const navigation = createNavigation();

/* ---------------- 基础工具 ---------------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/* ---------------- 状态映射 ---------------- */

const PLAN_STATUS_CLASS = {
  规划中: 'st-planning',
  执行中: 'st-doing',
  待综合验证: 'st-verifying',
  待用户审批: 'st-approval',
  已完成: 'st-done',
  目录缺失: 'st-missing',
};

const CHIP_CLASS = {
  规划中: 'planning',
  执行中: 'doing',
  待综合验证: 'verifying',
  待用户审批: 'approval',
  已完成: 'done',
  目录缺失: 'missing',
};

const TASK_CLASS = { 已完成: 'st-done', 进行中: 'st-doing', 未开始: 'st-todo', 阻塞: 'st-other' };

function planBadgeClass(status) {
  return PLAN_STATUS_CLASS[status] || 'st-other';
}

function statusBadge(status) {
  const text = status || '未知';
  return `<span class="badge ${planBadgeClass(text)}">${escapeHtml(text)}</span>`;
}

function taskBadge(status) {
  const text = stripMd(status || '—');
  return `<span class="badge ${TASK_CLASS[text] || 'st-other'}">${escapeHtml(text)}</span>`;
}

/* ---------------- Markdown 渲染 ---------------- */

let mdContext = null;

function inlineMd(text) {
  const format = (s) => escapeHtml(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let html = '', start = 0;
  for (const link of extractLinks(text, mdContext.refs)) {
    html += format(text.slice(start, link.start)) + linkHtml(link.text, link.href);
    start = link.end;
  }
  return html + format(text.slice(start));
}

function linkHtml(text, href) {
  if (!href) return `<span class="out-link" title="文档链接引用未定义">${escapeHtml(text)}</span>`;
  if (/^https?:/i.test(href)) {
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
  }
  const route = documentHref(mdContext.file, href);
  if (route) return `<a href="${escapeHtml(route)}">${escapeHtml(text)}</a>`;
  return `<span class="out-link" title="docs/plan 外部文档，本工具不读取">${escapeHtml(text)}</span>`;
}

/** 列表项（含 checkbox 变体），支持一层以上缩进嵌套 */
function buildNestedList(items) {
  const root = { indent: -1, children: [] };
  const stack = [root];
  for (const item of items) {
    const node = { ...item, children: [] };
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return toListHtml(root);
}

function toListHtml(node) {
  if (!node.children.length) return '';
  const tag = node.children[0].ordered ? 'ol' : 'ul';
  const lis = node.children
    .map((child) => {
      let inner = inlineMd(child.text);
      const sub = toListHtml(child);
      if (sub) inner += sub;
      if (child.checked === true) {
        return `<li class="task done"><span class="cb on">✔</span>${inner}</li>`;
      }
      if (child.checked === false) {
        return `<li class="task todo"><span class="cb">○</span>${inner}</li>`;
      }
      return `<li>${inner}</li>`;
    })
    .join('');
  return `<${tag}>${lis}</${tag}>`;
}

function renderTable(table) {
  const statusCol = table.columns.findIndex((c) => c.includes('状态'));
  const head = `<thead><tr>${table.columns.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${table.rows
    .map((cells) => {
      const tds = table.columns
        .map((col, ci) => {
          const cell = cells[ci] || '';
          if (ci === statusCol) return `<td class="status-cell">${taskBadge(cell)}</td>`;
          return `<td>${inlineMd(cell)}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('')}</tbody>`;
  return `<div class="table-wrap"><table>${head}${body}</table></div>`;
}

const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
const CHECK_RE = /^\[( |x|X)\]\s+(.*)$/;
const STOP_RE = /^(#{1,6}\s|```|\||>)/;

function mdToHtml(md, file, context = null) {
  const prevContext = mdContext;
  mdContext = context || { file, refs: collectReferences(md), slug: createHeadingSlugger() };
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.map(inlineMd).join('<br>')}</p>`);
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      flushPara();
      const buf = [line];
      i++;
      const close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const lv = heading[1].length;
      const text = heading[2].replace(/\s+#+\s*$/, '');
      const id = mdContext.slug(text);
      out.push(`<h${lv} id="${escapeHtml(id)}">${inlineMd(text)}</h${lv}>`);
      i++;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushPara();
      const block = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        block.push(lines[i]);
        i++;
      }
      out.push(renderTable({ columns: splitTableRow(block[0]), rows: block.slice(2).map(splitTableRow) }));
      continue;
    }

    const listMatch = line.match(LIST_RE);
    if (listMatch) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (!m) break;
        let text = m[3];
        let checked = null;
        const check = text.match(CHECK_RE);
        if (check) {
          checked = /x/i.test(check[1]);
          text = check[2];
        }
        const indent = m[1].length;
        i++;
        // 缩进续行并入当前项
        while (i < lines.length && lines[i].trim() !== '' && !STOP_RE.test(lines[i]) && !LIST_RE.test(lines[i])) {
          const ws = lines[i].match(/^\s*/)[0].length;
          if (ws <= indent) break;
          text += ` ${lines[i].trim()}`;
          i++;
        }
        items.push({ indent, ordered: /\d/.test(m[2]), text, checked });
      }
      out.push(buildNestedList(items));
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'), file, mdContext)}</blockquote>`);
      continue;
    }

    if (isReferenceDefinition(line)) { flushPara(); i++; continue; }

    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  mdContext = prevContext;
  return out.join('\n');
}

/* ---------------- 视图：总览 ---------------- */

function progressBar(pr) {
  if (!pr) return '<div class="progress-empty">无可统计的台账或清单</div>';
  const total = pr.total;
  const done = pr.done || 0;
  const doing = pr.doing || 0;
  const other = pr.other || 0;
  const todo = Math.max(0, total - done - doing - other);
  const pct = (n) => `${(total ? (n / total) * 100 : 0).toFixed(2)}%`;
  const legend = [`<span class="lg done">已完成 ${done}</span>`];
  if (doing) legend.push(`<span class="lg doing">进行中 ${doing}</span>`);
  if (todo) legend.push(`<span class="lg todo">未开始 ${todo}</span>`);
  if (other) legend.push(`<span class="lg other">其他 ${other}</span>`);
  legend.push(`<span class="lg src">共 ${total} 项 · ${escapeHtml(pr.source || '')}</span>`);
  return `<div class="progress" title="已完成 ${done}/${total}">
      <span class="seg done" style="width:${pct(done)}"></span>
      <span class="seg doing" style="width:${pct(doing)}"></span>
      <span class="seg todo" style="width:${pct(todo)}"></span>
      <span class="seg other" style="width:${pct(other)}"></span>
    </div>
    <div class="progress-legend">${legend.join('')}</div>`;
}

function issuePanel(issues, counts, title = '文档一致性') {
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.filter((i) => i.severity === 'warning').length;
  const visible = filterIssues(issues, { query: state.issueQuery, severity: state.auditFilter });
  const filters = [['all', `全部 ${issues.length}`], ['error', `阻断错误 ${errors}`], ['warning', `待核对 ${warnings}`]];
  const rows = visible.map((issue) => {
    const available = issue.path === 'README.md' || state.data.plans.some((p) => p.exists && (issue.path === `${p.dir}/README.md` || (p.files || []).some((f) => issue.path === `${p.dir}/${f.file}`)));
    const canLink = available && issue.path && !issue.path.startsWith('../') && issue.path.endsWith('.md');
    const label = `${issue.path}:${issue.line || 1}`;
    const location = canLink ? `<a href="#/file/${encodeURIComponent(issue.path)}">${escapeHtml(label)}</a>` : `<code>${escapeHtml(label)}</code>`;
    return `<details class="audit-issue ${issue.severity}">
      <summary><span>${issue.severity === 'error' ? '阻断错误' : '待核对'} · ${escapeHtml(issue.message)}</span><code>${escapeHtml(issue.code)}</code></summary>
      <div class="audit-location">资料位置：${location}</div>
      <dl class="audit-values"><div><dt>预期 / 对照</dt><dd>${escapeHtml(issue.expected)}</dd></div><div><dt>实际记录</dt><dd>${escapeHtml(issue.actual)}</dd></div></dl>
      <p class="audit-action">建议：${escapeHtml(issue.action)}</p>
    </details>`;
  }).join('');
  return `<section class="audit-panel" aria-label="${escapeHtml(title)}">
    <div class="audit-heading"><h2>${escapeHtml(title)}</h2></div>
    <p class="audit-note">检查时间：${escapeHtml(new Date(state.data.generatedAt).toLocaleString())}</p>
    <div class="audit-counts">${counts.map(([label, value]) => `<span><strong>${escapeHtml(value)}</strong> ${escapeHtml(label)}</span>`).join('')}</div>
    <p class="audit-note">${errors ? '存在基础不一致，交接或完成前需要修正。' : '未发现阻断错误。'}${warnings ? ' 待核对项需确认用途和当前事实。' : ''} 静态检查不代表功能验收通过。</p>
    <div class="audit-filters" role="group" aria-label="筛选差异">${filters.map(([value, label]) => `<button type="button" data-audit-filter="${value}" aria-pressed="${state.auditFilter === value}">${label}</button>`).join('')}</div>
    <label class="field-label" for="issue-search">查找差异</label>
    <input id="issue-search" class="search-field" type="search" data-filter-input="issues" value="${escapeHtml(state.issueQuery)}" placeholder="描述、路径或检查编号" autocomplete="off" />
    <div class="audit-list">${rows || `<p class="audit-empty">${issues.length ? '当前筛选下没有差异。' : '当前没有差异。'}</p>`}</div>
  </section>`;
}

function planComparison(plan) {
  if (plan.registered && plan.exists && plan.indexStatus === plan.readmeStatus) return '';
  return `<div class="plan-comparison"><span>入口：<strong>${escapeHtml(plan.indexStatus || '未登记')}</strong></span><span>任务文档：<strong>${escapeHtml(plan.readmeStatus || '缺失')}</strong></span></div>`;
}

function planCard(plan) {
  if (!plan.exists) {
    return `<article class="card missing">
      <div class="card-head"><span class="card-title">${escapeHtml(plan.name)}</span>${statusBadge('目录缺失')}</div>
      <p class="scope">${escapeHtml(plan.scope || '总入口已登记，但任务 README 不可读取，请核对差异。')}</p>
    </article>`;
  }
  const docCount = plan.counts?.documents || 0;
  const issueCount = (plan.issues || []).length;
  return `<article class="card">
    <div class="card-head">
      <a class="card-title" href="#/plan/${encodeURIComponent(plan.dir)}">${escapeHtml(plan.name)}</a>
      ${statusBadge(plan.status)}
    </div>
    ${planComparison(plan)}
    <p class="scope">${escapeHtml(plan.scope || plan.goal || '')}</p>
    ${progressBar(plan.progress)}
    <div class="card-meta">
      <span>子任务 ${plan.progress ? `${plan.progress.done}/${plan.progress.total} 完成` : '—'}</span>
      <span>${docCount} 个实际文档</span>
      ${issueCount ? `<a class="audit-card-link" href="#/plan/${encodeURIComponent(plan.dir)}?anchor=plan-audit">${issueCount} 项差异需处理</a>` : '<span>基础记录一致</span>'}
    </div>
  </article>`;
}

function viewHome() {
  renderSidebar(null);
  if (state.error && !state.data) {
    $app.innerHTML = `<div class="error-panel">数据加载失败：${escapeHtml(state.error)}<br>请确认服务已启动且 docs/plan 目录可访问，然后刷新重试。</div>`;
    return;
  }
  const { summary, plans, audit } = state.data;
  const visiblePlans = filterPlans(plans, { query: state.planQuery, status: state.planStatus, attention: state.attentionOnly });
  const statuses = [['all', `全部 ${plans.length}`], ...['规划中', '执行中', '待综合验证', '待用户审批'].map((status) => [status, `${status} ${plans.filter((plan) => plan.status === status).length}`])];
  const errors = audit.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = audit.issues.filter((issue) => issue.severity === 'warning').length;
  const chips = Object.entries(summary)
    .map(([k, v]) => `<span class="chip ${CHIP_CLASS[k] || 'unknown'}">${escapeHtml(k)} · ${v}</span>`)
    .join('');
  $app.innerHTML = `
    ${refreshNotice()}
    <section class="overview-head"><div><p class="eyebrow">活动计划</p><h1>任务总览</h1><p>按当前阶段和检查结果查找任务。检查只核对记录，不能替代业务验收。</p></div><span class="total-count">${plans.length} 项任务</span></section>
    <section class="stats" aria-label="任务阶段">${chips}</section>
    <a class="audit-summary" href="#/issues"><span>文档检查</span><strong>${errors ? `${errors} 项阻断错误` : '无阻断错误'}</strong><span>${warnings} 项待核对 <span aria-hidden="true">→</span></span></a>
    <section class="plan-section" aria-label="任务列表">
      <div class="section-head"><h2>任务列表</h2><span>显示 ${visiblePlans.length} / ${plans.length} 项</span></div>
      <label class="field-label" for="plan-search">查找任务</label>
      <input id="plan-search" class="search-field" type="search" data-filter-input="plans" value="${escapeHtml(state.planQuery)}" placeholder="名称、目录或范围" autocomplete="off" />
      <div class="filter-row" role="group" aria-label="按阶段筛选">${statuses.map(([value, label]) => `<button type="button" data-plan-status="${value}" aria-pressed="${state.planStatus === value}">${label}</button>`).join('')}</div>
      <button type="button" class="attention-filter" data-attention-only aria-pressed="${state.attentionOnly}">只看需要处理的任务 · ${plans.filter((plan) => (plan.issues || []).length).length}</button>
      <div class="plan-list">${visiblePlans.map(planCard).join('') || '<p class="empty-state">没有符合条件的任务。可以清除搜索词或切换筛选条件。</p>'}</div>
    </section>`;
}

function viewIssues() {
  renderSidebar(null);
  if (state.error && !state.data) return viewHome();
  const { audit } = state.data;
  $app.innerHTML = `${refreshNotice()}
    <nav class="crumbs"><a href="#/">← 任务总览</a></nav>
    <header class="section-head"><div><p class="eyebrow">计划记录</p><h1>检查差异</h1></div></header>
    ${issuePanel(audit.issues, [['入口登记', audit.summary.registered], ['实际任务目录', audit.summary.directories], ['实际文档', audit.summary.documents]])}`;
}

function refreshNotice() {
  return state.refreshError ? `<div class="error-panel refresh-error" role="alert">重新检查失败：${escapeHtml(state.refreshError)}。当前仍显示上次成功读取的结果。</div>` : '';
}

/* ---------------- 视图：侧栏目录树 ---------------- */

/** 计划内可跳转的关联文档；服务端已经排除计划自身 README。 */
function planDocs(plan) {
  return (plan.files || []).filter((f) => f.inside);
}

/**
 * 渲染左侧目录树：仅列当前计划的关联文档，每项两行（文件名 + 文档一级标题）。
 * activeRel 命中的文档高亮且不可点，用于子任务视图定位当前文件；无计划上下文时隐藏侧栏。
 */
function renderSidebar(plan, activeRel) {
  if (!plan) {
    state.sidebarOpen = false;
    $sidebar.hidden = true;
    $sidebar.innerHTML = '';
    return;
  }
  const active = activeRel ? String(activeRel).replace(/\\/g, '/') : '';
  const docs = planDocs(plan);
  const items = docs
    .map((f) => {
      const full = posixJoin(plan.dir, f.file);
      const fileLabel = escapeHtml(f.file);
      // 第二行优先取文档正文一级标题；缺标题时退回 README 中的链接文字
      const title = f.title || f.name || '';
      const titleLine = title ? `<span class="tree-title">${escapeHtml(title)}</span>` : '';
      const inner = `<span class="tree-file">${fileLabel}</span>${titleLine}`;
      if (active && full === active) {
        return `<span class="tree-item active" title="当前文件">${inner}</span>`;
      }
      return `<a class="tree-item" href="#/file/${encodeURIComponent(full)}">${inner}</a>`;
    })
    .join('');
  $sidebar.innerHTML = `<div class="tree-head">关联文档 · ${escapeHtml(plan.name)}</div>
    ${items ? `<nav class="tree">${items}</nav>` : '<div class="tree-empty">该计划暂无关联文档</div>'}`;
  $sidebar.hidden = false;
  $sidebar.classList.toggle('is-open', state.sidebarOpen);
}

function sidebarToggle() {
  return `<button type="button" class="sidebar-toggle" data-sidebar-toggle aria-controls="sidebar" aria-expanded="${state.sidebarOpen}">${state.sidebarOpen ? '关闭目录' : '打开目录'}</button>`;
}

/* ---------------- 视图：任务详情 ---------------- */

function viewPlan(dir) {
  const plan = state.data.plans.find((p) => p.dir === dir);
  if (!plan || !plan.exists) {
    renderSidebar(null);
    $app.innerHTML = `<nav class="crumbs"><a href="#/">← 总览</a></nav><div class="error-panel">计划目录不存在：${escapeHtml(dir)}</div>`;
    return;
  }
  renderSidebar(plan);
  $app.innerHTML = `
    ${refreshNotice()}
    <nav class="crumbs"><a href="#/">← 总览</a><span class="sep">/</span><span>${escapeHtml(plan.name)}</span>${sidebarToggle()}</nav>
    <header class="plan-head">
      <h1>${escapeHtml(plan.name)}</h1>
      ${statusBadge(plan.status)}
    </header>
    ${planComparison(plan)}
    ${progressBar(plan.progress)}
    <section class="plan-document"><h2>计划文档</h2><article class="md">${mdToHtml(plan.markdown, `${plan.dir}/README.md`)}</article></section>
    <div id="plan-audit">${issuePanel(plan.issues || [], [['台账关联小任务文件', plan.counts.ledgerFiles], ['带状态的小任务文件', plan.counts.taskFiles], ['全部文档', plan.counts.documents], ['入口可达文档', plan.counts.reachableDocuments]], '本任务差异')}</div>`;
}

/* ---------------- 视图：子任务文件 ---------------- */

async function viewFile(rel, ticket) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^docs\/plan\//i, '');
  // 所属计划 = 路径首段匹配计划目录；子层级视图保留计划上下文（面包屑 + 关联文档可随时跳转/返回）
  const plan = state.data.plans.find((p) => p.exists && p.dir === norm.split('/')[0]);
  const fileName = norm.split('/').slice(1).join('/') || norm;
  const crumbs = plan
    ? `<nav class="crumbs"><a href="#/">← 总览</a><span class="sep">/</span><a href="#/plan/${encodeURIComponent(plan.dir)}">${escapeHtml(plan.name)}</a><span class="sep">/</span><span>${escapeHtml(fileName)}</span>${sidebarToggle()}</nav>`
    : `<nav class="crumbs"><a href="#/">← 总览</a><span class="sep">/</span><span>${escapeHtml(norm)}</span></nav>`;
  $app.innerHTML = '<div class="loading">加载中…</div>';
  renderSidebar(plan || null, norm);
  try {
    const body = await loadCurrentFile(norm, ticket);
    if (!body || !ticket.isCurrent()) return;
    $app.innerHTML = `${refreshNotice()}${crumbs}
      <article class="md">${mdToHtml(body.markdown, norm)}</article>`;
  } catch (err) {
    if (!ticket.isCurrent()) return;
    $app.innerHTML = `${refreshNotice()}${crumbs}
      <div class="error-panel">无法读取文件：${escapeHtml(String(err.message || err))}</div>`;
  }
}

/* ---------------- 路由 ---------------- */

async function route({ preserveScroll = false, focusInput = null, cursor = null } = {}) {
  const previousScroll = window.scrollY;
  const ticket = navigation.begin();
  if (state.error && !state.data) return viewHome();
  if (!state.data) return;
  const target = parseRoute(location.hash);
  document.querySelectorAll('[data-top-nav]').forEach((link) => {
    const active = target.kind === link.dataset.topNav || (link.dataset.topNav === 'home' && ['plan', 'file'].includes(target.kind));
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (target.kind === 'invalid') {
    renderSidebar(null);
    $app.innerHTML = '<nav class="crumbs"><a href="#/">← 总览</a></nav><div class="error-panel">无法识别文档地址，请从总览重新打开。</div>';
    return;
  }
  if (target.kind === 'file') await viewFile(target.path, ticket);
  else if (target.kind === 'plan') viewPlan(target.path);
  else if (target.kind === 'issues') viewIssues();
  else viewHome();
  if (!ticket.isCurrent()) return;
  if (target.anchor) document.getElementById(target.anchor)?.scrollIntoView();
  else if (preserveScroll) window.scrollTo(0, previousScroll);
  else window.scrollTo(0, 0);
  if (focusInput) {
    const input = $app.querySelector(`[data-filter-input="${focusInput}"]`);
    input?.focus();
    if (cursor !== null && input?.setSelectionRange) input.setSelectionRange(cursor, cursor);
  }
}

function updateRefreshUi() {
  $refreshState.textContent = state.refreshing ? '正在检查…' : state.refreshError ? '刷新失败，显示上次结果' : state.data ? `检查于 ${new Date(state.data.generatedAt).toLocaleString()}` : '尚未读取计划';
  document.querySelectorAll('[data-refresh]').forEach((button) => {
    button.disabled = state.refreshing;
    button.textContent = state.refreshing ? '检查中…' : '重新检查';
  });
}

async function boot() {
  if (state.refreshing) return;
  const hadData = Boolean(state.data);
  state.refreshing = true;
  state.refreshError = null;
  $app.querySelector('.refresh-error')?.remove();
  updateRefreshUi();
  try {
    const res = await fetch('/api/plan');
    if (!res.ok) throw new Error(`API 返回 ${res.status}`);
    const data = await res.json();
    state.data = data;
    state.error = null;
  } catch (err) {
    if (hadData) state.refreshError = String(err.message || err);
    else state.error = String(err.message || err);
  }
  state.refreshing = false;
  if (hadData && state.refreshError) {
    $app.insertAdjacentHTML('afterbegin', refreshNotice());
  } else {
    await route({ preserveScroll: hadData });
  }
  updateRefreshUi();
}

$app.addEventListener('click', (event) => {
  const filter = event.target.closest('[data-audit-filter]');
  if (filter) { state.auditFilter = filter.dataset.auditFilter; route({ preserveScroll: true }); return; }
  const status = event.target.closest('[data-plan-status]');
  if (status) { state.planStatus = status.dataset.planStatus; route({ preserveScroll: true }); return; }
  if (event.target.closest('[data-attention-only]')) { state.attentionOnly = !state.attentionOnly; route({ preserveScroll: true }); return; }
  const toggle = event.target.closest('[data-sidebar-toggle]');
  if (toggle) {
    state.sidebarOpen = !state.sidebarOpen;
    $sidebar.classList.toggle('is-open', state.sidebarOpen);
    toggle.setAttribute('aria-expanded', String(state.sidebarOpen));
    toggle.textContent = state.sidebarOpen ? '关闭目录' : '打开目录';
  }
});
$app.addEventListener('input', (event) => {
  const kind = event.target.dataset.filterInput;
  if (!kind) return;
  if (kind === 'plans') state.planQuery = event.target.value;
  if (kind === 'issues') state.issueQuery = event.target.value;
  route({ preserveScroll: true, focusInput: kind, cursor: event.target.selectionStart });
});
$sidebar.addEventListener('click', (event) => {
  if (!event.target.closest('a')) return;
  state.sidebarOpen = false;
  $sidebar.classList.remove('is-open');
});
document.addEventListener('click', (event) => {
  if (event.target.closest('[data-refresh]')) boot();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.sidebarOpen) {
    state.sidebarOpen = false;
    $sidebar.classList.remove('is-open');
    const toggle = $app.querySelector('[data-sidebar-toggle]');
    toggle?.setAttribute('aria-expanded', 'false');
    if (toggle) toggle.textContent = '打开目录';
    toggle?.focus();
  }
});
window.addEventListener('hashchange', () => { state.sidebarOpen = false; route(); });
boot();
