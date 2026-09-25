import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkLinks } from '../check-links.mjs';

test('checks local links and anchors in a temporary documentation root', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cherynyxus-docs-'));
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs', 'target.md'), '# Target\n\n## Section\n', 'utf8');
  await writeFile(path.join(repoRoot, 'docs', 'source.md'), [
    '[valid](./target.md#SECTION)',
    '[missing file](./missing.md)',
    '[missing anchor](./target.md#missing)',
    '[external](https://example.com/not-checked)',
    '`[ignored](./ignored.md)`',
  ].join('\n'), 'utf8');

  const result = await checkLinks({ repoRoot, roots: ['docs'] });
  assert.equal(result.files.length, 2);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues[0].message, /本地目标不存在|锚点不存在/);
  assert.match(result.issues[1].message, /本地目标不存在|锚点不存在/);
});
