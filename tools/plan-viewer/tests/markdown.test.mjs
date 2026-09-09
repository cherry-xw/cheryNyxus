import test from 'node:test';
import assert from 'node:assert/strict';
import { findTables, extractLinks, collectReferences, metadataValue, createHeadingSlugger } from '../public/markdown.js';

const table = '| 任务 | 状态 |\n| --- | --- |\n| [A][task] | 规划中 |';

test('ignores fenced sample tables and reference definitions, including longer fences', () => {
  const md = '````md\n' + table + '\n```\n[task]: wrong/README.md\n````\n~~~\n' + table + '\n~~~\n' + table + '\n[task]: a/README.md';
  assert.equal(findTables(md).length, 1);
  assert.equal(collectReferences(md).get('task'), 'a/README.md');
});

test('quoted fenced samples are ignored and escaped pipes remain in their cells', () => {
  const md = '> ```md\n> ' + table.replaceAll('\n', '\n> ') + '\n> ```\n| 任务 | 状态 |\n| --- | --- |\n| A \\| B | 规划中 |';
  assert.deepEqual(findTables(md)[0].rows, [['A | B', '规划中']]);
});

test('inline, full, collapsed and shortcut references share destinations', () => {
  const refs = collectReferences('[ task ]: <a b/README.md> "Title"\n[task]: ignored/README.md');
  for (const text of ['[Task][ TASK ]', '[Task][]', '[Task]', '[Task](<a b/README.md> "Title")']) {
    assert.equal(extractLinks(text, refs)[0].href, 'a b/README.md');
  }
  assert.equal(extractLinks('[Task](a/README.md#section)')[0].href, 'a/README.md#section');
  assert.equal(extractLinks('[Task](a(test)/README.md)')[0].href, 'a(test)/README.md');
});

test('undefined explicit references are retained, code and image examples are not links', () => {
  assert.equal(extractLinks('[Task][missing]')[0].href, null);
  assert.deepEqual(extractLinks('`[Task](absent/README.md)` ![image](absent.md)'), []);
  assert.deepEqual(extractLinks('[unused]: unused.md', collectReferences('[unused]: unused.md')), []);
});

for (const label of ['状态', '进度']) {
  test(`${label} accepts ordinary, bold and quoted metadata but skips code examples`, () => {
    const value = label === '状态' ? '规划中' : '0/28 个任务';
    for (const line of [`${label}：${value}`, `**${label}：** ${value}`, `**${label}**: **${value}**`, `> **${label}：** ${value}`]) {
      assert.equal(metadataValue('```\n' + label + '：wrong\n```\n' + line, label), value);
    }
    assert.equal(metadataValue('```\n' + label + '：wrong\n```', label), null);
    assert.equal(metadataValue('说明中提到' + label + '：wrong', label), null);
  });
}

test('metadata is not lost after the former arbitrary 2000-character cutoff', () => {
  assert.equal(metadataValue('# A\n' + 'description '.repeat(250) + '\n> 状态：规划中', '状态'), '规划中');
});

test('heading slugs preserve Chinese and disambiguate repeats and natural suffixes', () => {
  const slug = createHeadingSlugger();
  assert.equal(slug('1.1 文档创建时间'), '11-文档创建时间');
  assert.equal(slug('Hello **World**!'), 'hello-world');
  assert.equal(slug('Hello World'), 'hello-world-1');
  assert.equal(slug('Hello World-1'), 'hello-world-1-1');
  assert.equal(slug('Hello World'), 'hello-world-2');
});
