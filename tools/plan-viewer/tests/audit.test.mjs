import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { auditPlans } from '../audit.mjs';

const index = (rows) => `# Plans\n\n| 任务 | 状态 | 范围 |\n| --- | --- | --- |\n${rows}`;
const row = (id, state = '执行中') => `| [${id}](${id}/README.md) | ${state} | Scope |`;
const md = (state = '执行中', extra = '') => `# Task\n\n**文档创建时间：** 2026-10-11T08:00:00+08:00\n\n**状态：** ${state}\n\n**计划形式：** 单页\n\n## 当前恢复检查点\n\n下一步核对需求。\n${extra}`;
function setup(t, entries = row('a')) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'plan-audit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, content) => { const file = path.join(root, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
  write('README.md', index(entries)); write('a/README.md', md());
  return { root, write, audit: () => auditPlans({ planDir: root }), codes: () => auditPlans({ planDir: root }).issues.map((i) => i.code) };
}

test('single-page tasks need no artificial child files', (t) => {
  const f = setup(t); assert.deepEqual(f.audit().issues, []);
});

test('blank table breaks and unregistered directories cannot silently pass', (t) => {
  const f = setup(t, row('a') + '\n\n' + row('b')); f.write('b/README.md', md());
  const report = f.audit();
  assert.equal(report.summary.registered, 1); assert.equal(report.summary.directories, 2);
  assert.equal(report.plans.length, 2);
  assert.ok(f.codes().includes('INDEX_ROW')); assert.ok(f.codes().includes('PLAN_UNREGISTERED'));
});

test('reports duplicate, missing and inconsistent states with both values', (t) => {
  const f = setup(t, [row('a', '规划中'), row('a'), row('gone')].join('\n'));
  const report = f.audit();
  for (const code of ['PLAN_DUPLICATE', 'PLAN_MISSING', 'STATUS_MISMATCH']) assert.ok(report.issues.some((i) => i.code === code));
  const mismatch = report.issues.find((i) => i.code === 'STATUS_MISMATCH');
  assert.match(mismatch.expected, /执行中/); assert.match(mismatch.actual, /规划中/); assert.ok(mismatch.line > 1);
});

test('forward planned tasks may have no file, active tasks must have one', (t) => {
  const f = setup(t);
  f.write('a/README.md', md().replace('**计划形式：** 单页', '') + '\n| 任务 | 状态 |\n| --- | --- |\n| Later | 未开始 |\n| Now | 进行中 |');
  assert.equal(f.codes().filter((c) => c === 'TASK_FILE_MISSING').length, 1);
});

test('task state, completion remnants and declared progress are compared', (t) => {
  const f = setup(t);
  f.write('a/README.md', md() + '\n**进度：** 0/2\n\n| 任务 | 状态 |\n| --- | --- |\n| [Child](child.md) | 已完成 |');
  f.write('a/child.md', '# Child\n\n**状态：** 进行中');
  for (const code of ['TASK_STATUS_MISMATCH', 'COMPLETED_FILE', 'PROGRESS_MISMATCH']) assert.ok(f.codes().includes(code));
});

test('reference materials and future work are not counted as child tasks', (t) => {
  const f = setup(t);
  f.write('a/README.md', md() + '\n[Design](design.md)\n\n| 任务 | 状态 |\n| --- | --- |\n| Later | 未开始 |');
  f.write('a/design.md', '# Design\n\n**状态：** 方案已确认\n\n## Old example\n\n**状态：** 进行中');
  assert.equal(f.audit().plans[0].counts.taskFiles, 0);
  assert.ok(!f.codes().includes('TASK_UNREGISTERED'));
});

test('links, escaped filenames and section anchors are checked without running commands', (t) => {
  const f = setup(t);
  f.write('a/README.md', md() + '\n[Valid](<space name.md#目标>)\n[Absent](absent.md)\n[Wrong](space%20name.md#不存在)\n[Outside](../../outside.md)');
  f.write('a/space name.md', '# Doc\n\n## 目标');
  for (const code of ['LINK_MISSING', 'LINK_ANCHOR', 'LINK_BOUNDARY']) assert.ok(f.codes().includes(code));
  assert.equal(f.codes().filter((c) => c === 'LINK_MISSING').length, 1);
});

test('orphan documentation is reported for review, not deleted or counted as a task', (t) => {
  const f = setup(t); f.write('a/research.md', '# Research');
  const warning = f.audit().issues.find((i) => i.code === 'DOCUMENT_UNREFERENCED');
  assert.equal(warning.severity, 'warning'); assert.equal(f.audit().plans[0].counts.taskFiles, 0);
});

test('misplaced scripts and outputs fail, managed outputs are not read', (t) => {
  const f = setup(t); f.write('a/debug.mjs', 'throw new Error("never execute")'); f.write('a/run.log', 'log'); f.write('a/verify/out/image.png', 'not an image'); f.write('a/verify/check.py', '# check');
  for (const code of ['SCRIPT_LOCATION', 'ARTIFACT_LOCATION']) assert.ok(f.codes().includes(code));
  assert.equal(f.audit().issues.filter((i) => i.path.includes('verify/out')).length, 0);
});

test('explicit task IDs reject missing dependencies and cycles', (t) => {
  const f = setup(t);
  f.write('a/README.md', md() + '\n| ID | 任务 | 状态 | 依赖 ID |\n| --- | --- | --- | --- |\n| A | One | 未开始 | B |\n| B | Two | 未开始 | A, Gone |');
  assert.ok(f.codes().includes('DEPENDENCY_CYCLE')); assert.ok(f.codes().includes('DEPENDENCY_MISSING'));
});

test('approval state cannot conceal unfinished ledger work', (t) => {
  const f = setup(t, row('a', '待用户审批'));
  f.write('a/README.md', md('待用户审批') + '\n| 任务 | 状态 |\n| --- | --- |\n| Work | 未开始 |');
  assert.ok(f.codes().includes('APPROVAL_UNFINISHED'));
});

test('symlinks outside the project are not followed', (t) => {
  const f = setup(t); const outside = mkdtempSync(path.join(os.tmpdir(), 'plan-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'secret.md'), '# Must not read');
  symlinkSync(path.join(outside, 'secret.md'), path.join(f.root, 'a/linked.md'));
  f.write('a/README.md', md() + '\n[Linked](linked.md)');
  assert.ok(f.codes().includes('SYMLINK')); assert.ok(f.codes().includes('LINK_BOUNDARY'));
});

test('citation labels in research text are not mistaken for undefined Markdown links', (t) => {
  const f = setup(t);
  f.write('a/README.md', md() + '\n[S1][S2]\n- [S1] [Official](https://example.org)\n- [S2] [Official](https://example.org)');
  assert.ok(!f.codes().includes('LINK_UNDEFINED'));
});


test('nonempty failed verification is not accepted for approval', (t) => {
  const f = setup(t, row('a', '待用户审批'));
  f.write('a/README.md', md('待用户审批') + '\n| 目标 | 结论 |\n| --- | --- |\n| Build | 失败 |');
  assert.ok(f.codes().includes('APPROVAL_RESULT'));
});


test('escaped pipes in index scope do not create phantom loose rows', (t) => {
  const f = setup(t, '| [a](a/README.md) | 执行中 | A \\| B |');
  assert.ok(!f.codes().includes('INDEX_ROW'));
});


test('the ignored output location must still be a real directory', (t) => {
  const f = setup(t); f.write('a/verify/out', 'not a directory');
  assert.ok(f.codes().includes('OUTPUT_DIRECTORY'));
});
