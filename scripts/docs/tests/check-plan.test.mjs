import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPlan } from '../check-plan.mjs';

test('checks plan boundaries without requiring the repository plan lint', async (t) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cheryNyxus-plan-'));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  await mkdir(path.join(repoRoot, 'docs', 'plan', 'task-a', 'verify', 'out'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs', 'plan', 'README.md'), '# Plans\n\n| 任务 | 状态 |\n| --- | --- |\n| [A](task-a/README.md) | 执行中 |\n', 'utf8');
  await writeFile(path.join(repoRoot, 'docs', 'plan', 'task-a', 'README.md'), '# Task\n\n**状态：** 执行中\n', 'utf8');
  await writeFile(path.join(repoRoot, '.gitignore'), 'docs/plan/*/verify/out/\n', 'utf8');

  const result = await checkPlan({ repoRoot });
  assert.deepEqual(result.issues, []);
});
