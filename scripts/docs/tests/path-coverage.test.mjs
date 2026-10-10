import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveTarget, checkLinks } from '../check-links.mjs';

test('rejects migrated source directories even when empty legacy folders exist', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-moved-'));
  try {
    mkdirSync(path.join(root, 'src', 'agent'), { recursive: true });
    const result = resolveTarget(path.join(root, 'README.md'), 'src/agent/', root);
    assert.match(result.error, /旧源码路径已迁移/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('default link coverage includes root entries and component documents', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'docs-entry-'));
  try {
    writeFileSync(path.join(root, 'README.md'), '[missing](missing.md)');
    mkdirSync(path.join(root, 'deployment'), { recursive: true });
    writeFileSync(path.join(root, 'deployment', 'README.md'), '[missing](missing.md)');
    const result = await checkLinks({ repoRoot: root });
    assert.equal(result.issues.length, 2);
    assert.ok(result.issues.some(item => item.file === 'README.md'));
    assert.ok(result.issues.some(item => item.file === 'deployment/README.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
