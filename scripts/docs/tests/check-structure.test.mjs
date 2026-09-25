import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkStructure } from '../check-structure.mjs';

test('checks entries, nested READMEs, and orphan Markdown files', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cherynyxus-structure-'));
  await mkdir(path.join(repoRoot, 'docs', 'module'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs', 'README.md'), '[module](./module/README.md)\n', 'utf8');
  await writeFile(path.join(repoRoot, 'docs', 'module', 'README.md'), '# Module\n', 'utf8');
  await writeFile(path.join(repoRoot, 'docs', 'module', 'topic.md'), '# Topic\n', 'utf8');
  await writeFile(path.join(repoRoot, 'AGENTS.md'), '# Agent\n', 'utf8');
  await writeFile(path.join(repoRoot, 'README.md'), '# Root\n', 'utf8');

  const result = await checkStructure({
    repoRoot,
    config: {
      rootEntries: ['AGENTS.md', 'README.md'],
      managedRoots: [{ path: 'docs', entry: 'docs/README.md', navigation: 'indexed' }],
      orphanExclusions: [],
      readmeExclusions: [],
    },
  });

  assert.equal(result.details.orphans.length, 1);
  assert.equal(result.details.missingReadmes.length, 0);
  assert.equal(result.issues[0].code, 'S3');
});
