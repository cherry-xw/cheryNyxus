import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectAnchors,
  collectReferences,
  extractLinks,
  headingSlug,
} from '../markdown.mjs';

test('extracts inline and reference links while ignoring code and images', () => {
  const markdown = [
    '[inline](./target.md#section)',
    '[reference][target]',
    '[target]: ./target.md#reference',
    '`[ignored](./missing.md)`',
    '![image](./missing.png)',
    '```md',
    '[fenced](./missing.md)',
    '```',
  ].join('\n');

  assert.deepEqual([...collectReferences(markdown).entries()], [['target', './target.md#reference']]);
  assert.deepEqual(extractLinks(markdown).map((link) => link.href), [
    './target.md#section',
    './target.md#reference',
  ]);
});

test('creates stable duplicate heading anchors', () => {
  const markdown = '# 标题\n\n## Same title\n\n## Same title\n\n<a id="manual"></a>';
  assert.equal(headingSlug('Same title'), 'same-title');
  assert.deepEqual([...collectAnchors(markdown)], ['标题', 'same-title', 'same-title-1', 'manual']);
});
