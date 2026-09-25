import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkMetadata, parseFrontMatter } from '../check-metadata.mjs';

test('parses supported front matter fields', () => {
  const parsed = parseFrontMatter([
    '---',
    'title: "Example"',
    'summary: Short page',
    'read_when:',
    '  - first task',
    '  - second task',
    'generated: false',
    '---',
    '# Example',
  ].join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fields, {
    title: 'Example',
    summary: 'Short page',
    read_when: ['first task', 'second task'],
    generated: false,
  });
});

test('rejects front matter while project metadata is disabled', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'cherynyxus-metadata-'));
  await mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await writeFile(path.join(repoRoot, 'docs', 'README.md'), '---\ntitle: Example\n---\n# Example\n', 'utf8');
  const config = {
    managedRoots: [{ path: 'docs', entry: 'docs/README.md', navigation: 'indexed' }],
    sourcePolicy: { generated: [], externalMirrors: [], metadata: { enabled: false, fields: ['title'] } },
  };
  const result = await checkMetadata({ repoRoot, config });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'M2');
});
