import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portable = path.resolve(tool, '../../docs/standards/documentation/tools');
const table = (cell) => `| 任务 | 状态 |\n| --- | --- |\n| ${cell} | 规划中 |`;

function fixture(t, index, readme = '状态：规划中') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plan-viewer-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('plan-viewer-test-'));
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(path.join(dir, 'a'));
  writeFileSync(path.join(dir, 'README.md'), index);
  writeFileSync(path.join(dir, 'a', 'README.md'), readme);
  return dir;
}

for (const entry of [path.join(tool, 'lint-source.mjs'), path.join(tool, 'lint.mjs'), path.join(portable, 'lint.mjs')]) {
  test(`lint cases: ${path.relative(tool, entry)}`, async (t) => {
    const cases = [
      ['inline', table('[A](a/README.md)'), '状态：规划中', 0],
      ['full reference', table('[A][task]') + '\n[task]: a/README.md', '> **状态：** 规划中', 0],
      ['collapsed reference', table('[A][]') + '\n[A]: a/README.md', '**状态：** 规划中', 0],
      ['shortcut reference', table('[A]') + '\n[A]: a/README.md "Title"', '状态：规划中', 0],
      ['broken reference destination', table('[A][task]') + '\n[task]: missing/README.md', '状态：规划中', 1],
      ['undefined reference', table('[A][missing]'), '状态：规划中', 1],
      ['missing status via reference', table('[A][task]') + '\n[task]: a/README.md', '# No status', 1],
      ['sample table', '```md\n' + table('[Example](missing/README.md)') + '\n```\n' + table('[A](a/README.md)'), '状态：规划中', 0],
      ['sample status only', table('[A](a/README.md)'), '~~~\n状态：规划中\n~~~', 1],
      ['directory is not README', table('[A](a/)'), '状态：规划中', 1],
      ['missing link', table('A'), '状态：规划中', 1],
      ['second task table also checked', table('[A](a/README.md)') + '\n\n' + table('[B](missing/README.md)'), '状态：规划中', 1],
      ['root escape', table('[A](../README.md)'), '状态：规划中', 1],
    ];
    for (const [name, index, md, code] of cases) {
      const dir = fixture(t, index, md);
      const result = spawnSync(process.execPath, [entry, '--plan-dir=' + dir], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(result.status, code, `${name}: ${result.stdout}\n${result.stderr}`);
      if (code === 0) assert.match(result.stdout, /计划目录 1 个/);
    }
  });
}

async function startServer(t, entry, dir) {
  const wrapper = `import http from 'node:http';
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once('listening', () => console.log('BOUND ' + JSON.stringify(this.address())));
      return listen.apply(this, args);
    };
    process.argv = ['node', process.env.PLAN_TEST_ENTRY, '--port=0', '--plan-dir=' + process.env.PLAN_TEST_DIR];
    await import(process.env.PLAN_TEST_ENTRY);`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', wrapper], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PLAN_TEST_ENTRY: pathToFileURL(entry).href, PLAN_TEST_DIR: dir },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill(); await closed; }
  });
  let output = '';
  const bound = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timeout: ' + output)), 10000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exit ${code}: ${output}`)); });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/BOUND (\{[^\n]+\})/);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
  });
  assert.equal(bound.address, '127.0.0.1');
  return `http://127.0.0.1:${bound.port}`;
}

for (const entry of [path.join(tool, 'server.mjs'), path.join(tool, 'plan-viewer.mjs'), path.join(portable, 'plan-viewer.mjs')]) {
  test(`HTTP and metadata: ${path.relative(tool, entry)}`, { timeout: 15000 }, async (t) => {
    const md = '# A\n\n> **状态：** 规划中\n**进度：** 0/28 个任务\n\n| 任务 | 状态 |\n| --- | --- |\n| One | 已完成 |\n\n[Manual][guide]\n[guide]: verify/manual.md';
    const dir = fixture(t, '````md\n' + table('[Sample](missing/README.md)') + '\n````\n' + table('[A][task]') + '\n[task]: ./a/README.md', md);
    mkdirSync(path.join(dir, 'a', 'verify'));
    writeFileSync(path.join(dir, 'a', 'verify', 'manual.md'), '# Manual\n\n## 目标');
    const base = await startServer(t, entry, dir);
    const data = await (await fetch(base + '/api/plan')).json();
    assert.equal(data.plans.length, 1);
    assert.equal(data.plans[0].dir, 'a');
    assert.equal(data.plans[0].readmeStatus, '规划中');
    assert.equal(data.plans[0].progress.done, 1);
    assert.equal(data.plans[0].progress.total, 1);
    assert.equal(data.plans[0].progress.source, '台账统计');
    assert.ok(data.audit.issues.some((i) => i.code === 'PROGRESS_MISMATCH'));
    const cli = spawnSync(process.execPath, [path.join(tool, 'lint-source.mjs'), '--plan-dir=' + dir, '--json'], { encoding: 'utf8' });
    assert.deepEqual(data.audit.issues, JSON.parse(cli.stdout).issues);
    assert.ok(data.plans[0].files.some((f) => f.file === 'verify/manual.md' && f.inside));
    for (const [file, status] of [['a/verify/manual.md', 200], ['../outside.md', 400], ['a/absent.md', 404], ['a/script.js', 400]]) {
      const res = await fetch(base + '/api/file?p=' + encodeURIComponent(file));
      assert.equal(res.status, status, file);
      await res.text();
    }
    // Resource bytes only: no DOM execution, CSS inspection or UI assertions.
    for (const file of ['app.js', 'markdown.js', 'navigation.js']) {
      const res = await fetch(base + '/' + file);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), readFileSync(path.join(tool, 'public', file), 'utf8'));
    }
    writeFileSync(path.join(dir, 'a', 'README.md'), '**状态：** 执行中\n\n| 任务 | 状态 |\n| --- | --- |\n| One | **已完成；** 实现已迁入 |\n| Two | 进行中；等待验证 |\n| Three | 未开始；等待依赖 |');
    const updated = await (await fetch(base + '/api/plan')).json();
    assert.equal(updated.plans[0].progress.done, 1);
    assert.equal(updated.plans[0].progress.doing, 1);
    assert.equal(updated.plans[0].progress.todo, 1);
    assert.equal(updated.plans[0].progress.other, 0);
    assert.equal(updated.plans[0].progress.total, 3);
    mkdirSync(path.join(dir, 'unregistered'));
    writeFileSync(path.join(dir, 'unregistered/README.md'), '# Unregistered\n\n**状态：** 规划中');
    const union = await (await fetch(base + '/api/plan')).json();
    assert.equal(union.plans.length, 2);
    assert.ok(union.plans.some((p) => p.dir === 'unregistered' && !p.registered));
    assert.ok(union.audit.issues.some((i) => i.code === 'PLAN_UNREGISTERED'));
  });
}

test('build --if-missing skips and rebuilds in an isolated copy', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'plan-build-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const isolated = path.join(temp, 'tools/plan-viewer');
  mkdirSync(isolated, { recursive: true });
  for (const name of ['build.mjs', 'server.mjs', 'lint-source.mjs', 'audit.mjs', 'public']) cpSync(path.join(tool, name), path.join(isolated, name), { recursive: true });
  const build = () => spawnSync(process.execPath, [path.join(isolated, 'build.mjs'), '--if-missing'], { encoding: 'utf8', windowsHide: true });
  const first = build(); assert.equal(first.status, 0, first.stderr);
  const expected = readFileSync(path.join(isolated, 'plan-viewer.mjs'), 'utf8');
  const skip = build(); assert.equal(skip.status, 0, skip.stderr); assert.match(skip.stdout, /跳过构建/);
  rmSync(path.join(isolated, 'plan-viewer.mjs'));
  const rebuild = build(); assert.equal(rebuild.status, 0, rebuild.stderr); assert.match(rebuild.stdout, /构建完成/);
  assert.equal(readFileSync(path.join(isolated, 'plan-viewer.mjs'), 'utf8'), expected);
});

test('both portable scripts match their generated local copies and current source', () => {
  for (const name of ['plan-viewer.mjs', 'lint.mjs']) assert.equal(readFileSync(path.join(tool, name), 'utf8'), readFileSync(path.join(portable, name), 'utf8'));
  const result = spawnSync(process.execPath, [path.join(tool, 'build.mjs'), '--check'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
