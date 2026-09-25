import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPlan } from '../check-plan.mjs';

test('checks plan boundaries without requiring the repository plan lint', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cherynyxus-plan-'));
  await mkdir(path.join(repoRoot, 'docs', 'plan', 'task-a', 'verify', 'out'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs', 'plan', 'README.md'), '# Plans\n', 'utf8');
  await writeFile(path.join(repoRoot, 'docs', 'plan', 'task-a', 'README.md'), '# Task\n\n**状态：** 执行中\n', 'utf8');
  await writeFile(path.join(repoRoot, '.gitignore'), 'docs/plan/*/verify/out/\n', 'utf8');

  const result = await checkPlan({ repoRoot, runExistingLint: false });
  assert.deepEqual(result.issues, []);
});
