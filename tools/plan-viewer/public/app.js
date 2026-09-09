/* Plan Viewer 前端逻辑 —— 原生 JS，无构建、无外部依赖
 * 视图层级：#/ 总览 → #/plan/<dir> 任务详情 → #/file/<path> 子任务文件
 */

import { extractLinks, collectReferences, isReferenceDefinition, createHeadingSlugger, splitTableRow, stripMd } from './markdown.js';
import { posixJoin, documentHref, parseRoute, createNavigation, loadCurrentFile } from './navigation.js';

const $app = document.getElementById('app');
const state = { data: null, error: null };
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
  待综合验证: 'st-verifying',
  待用户审批: 'st-approval',
  已完成: 'st-done',
  目录缺失: 'st-missing',
};

const CHIP_CLASS = {
  规划中: 'planning',
  待综合验证: 'verifying',
  待用户审批: 'approval',
  已完成: 'done',
  目录缺失: 'missing',
};

const TASK_CLASS = { 已完成: 'st-done', 进行中: 'st-doing', 未开始: 'st-todo', 待开始: 'st-todo' };

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

function planCard(plan) {
  if (!plan.exists) {
    return `<article class="card missing">
      <div class="card-head"><span class="card-title">${escapeHtml(plan.name)}</span>${statusBadge('目录缺失')}</div>
      <p class="scope">${escapeHtml(plan.scope || '总入口已登记，但计划目录不存在（旧计划已归档或尚未创建）')}</p>
    </article>`;
  }
  const docCount = (plan.files || []).filter((f) => f.inside).length;
  return `<article class="card">
    <div class="card-head">
      <a class="card-title" href="#/plan/${encodeURIComponent(plan.dir)}">${escapeHtml(plan.name)}</a>
      ${statusBadge(plan.status)}
    </div>
    <p class="scope">${escapeHtml(plan.scope || plan.goal || '')}</p>
    ${progressBar(plan.progress)}
    <div class="card-meta">
      <span>子任务 ${plan.progress ? `${plan.progress.done}/${plan.progress.total} 完成` : '—'}</span>
      ${docCount ? `<span>${docCount} 个关联文档</span>` : ''}
    </div>
  </article>`;
}

function viewHome() {
  if (state.error) {
    $app.innerHTML = `<div class="error-panel">数据加载失败：${escapeHtml(state.error)}<br>请确认服务已启动且 docs/plan 目录可访问，然后刷新重试。</div>`;
    return;
  }
  const { summary, plans } = state.data;
  const chips = Object.entries(summary)
    .map(([k, v]) => `<span class="chip ${CHIP_CLASS[k] || 'unknown'}">${escapeHtml(k)} · ${v}</span>`)
    .join('');
  $app.innerHTML = `
    <section class="stats">${chips}<span class="chip">共 ${plans.length} 项</span></section>
    <section class="plan-list">${plans.map(planCard).join('')}</section>`;
}

/* ---------------- 视图：任务详情 ---------------- */

/** 关联文档 chips（activeRel 相同的文件高亮不可点，用于子层级视图定位当前文件） */
function docChipsHtml(plan, activeRel) {
  const active = activeRel ? String(activeRel).replace(/\\/g, '/') : '';
  return (plan.files || [])
    .filter((f) => f.inside && !/readme\.md$/i.test(f.file))
    .map((f) => {
      const full = posixJoin(plan.dir, f.file);
      const label = escapeHtml(f.name || f.file);
      if (active && full === active) {
        return `<span class="file-chip active" title="当前文件">${label}</span>`;
      }
      return `<a class="file-chip" href="#/file/${encodeURIComponent(full)}">${label}</a>`;
    })
    .join('');
}

function viewPlan(dir) {
  const plan = state.data.plans.find((p) => p.dir === dir);
  if (!plan || !plan.exists) {
    $app.innerHTML = `<nav class="crumbs"><a href="#/">← 总览</a></nav><div class="error-panel">计划目录不存在：${escapeHtml(dir)}</div>`;
    return;
  }
  const docChips = docChipsHtml(plan);
  $app.innerHTML = `
    <nav class="crumbs"><a href="#/">← 总览</a><span class="sep">/</span><span>${escapeHtml(plan.name)}</span></nav>
    <header class="plan-head">
      <h1>${escapeHtml(plan.name)}</h1>
      ${statusBadge(plan.status)}
      ${plan.readmeStatus && plan.readmeStatus !== plan.status ? statusBadge(plan.readmeStatus) : ''}
    </header>
    ${progressBar(plan.progress)}
    ${docChips ? `<section class="file-row"><span class="file-row-label">关联文档</span>${docChips}</section>` : ''}
    <article class="md">${mdToHtml(plan.markdown, `${plan.dir}/README.md`)}</article>`;
}

/* ---------------- 视图：子任务文件 ---------------- */

async function viewFile(rel, ticket) {
  const norm = String(rel).replace(/\\/g, '/').replace(/^docs\/plan\//i, '');
  // 所属计划 = 路径首段匹配计划目录；子层级视图保留计划上下文（面包屑 + 关联文档可随时跳转/返回）
  const plan = state.data.plans.find((p) => p.exists && p.dir === norm.split('/')[0]);
  const fileName = norm.split('/').slice(1).join('/') || norm;
  const crumbs = plan
    ? `<nav class="crumbs"><a href="#/">← 总览</a><span class="sep">/</span><a href="#/plan/${encodeURIComponent(plan.dir)}">${escapeHtml(plan.name)}</a><span class="sep">/</span><span>${escapeHtml(fileName)}</span></nav>`
    : `<nav class="crumbs"><a href="#/">← 总览</a><span class="sep">/</span><span>${escapeHtml(norm)}</span></nav>`;
  $app.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const body = await loadCurrentFile(norm, ticket);
    if (!body || !ticket.isCurrent()) return;
    const docChips = plan ? docChipsHtml(plan, norm) : '';
    $app.innerHTML = `${crumbs}
      ${docChips ? `<section class="file-row"><span class="file-row-label">关联文档</span>${docChips}</section>` : ''}
      <article class="md">${mdToHtml(body.markdown, norm)}</article>`;
  } catch (err) {
    if (!ticket.isCurrent()) return;
    $app.innerHTML = `${crumbs}
      <div class="error-panel">无法读取文件：${escapeHtml(String(err.message || err))}</div>`;
  }
}

/* ---------------- 路由 ---------------- */

async function route() {
  const ticket = navigation.begin();
  if (state.error) return viewHome();
  if (!state.data) return;
  const target = parseRoute(location.hash);
  if (target.kind === 'invalid') {
    $app.innerHTML = '<nav class="crumbs"><a href="#/">← 总览</a></nav><div class="error-panel">无法识别文档地址，请从总览重新打开。</div>';
    return;
  }
  if (target.kind === 'file') await viewFile(target.path, ticket);
  else if (target.kind === 'plan') viewPlan(target.path);
  else viewHome();
  if (!ticket.isCurrent()) return;
  if (target.anchor) document.getElementById(target.anchor)?.scrollIntoView();
  else window.scrollTo(0, 0);
}

async function boot() {
  try {
    const res = await fetch('/api/plan');
    if (!res.ok) throw new Error(`API 返回 ${res.status}`);
    state.data = await res.json();
  } catch (err) {
    state.error = String(err.message || err);
  }
  route();
}

window.addEventListener('hashchange', route);
boot();
