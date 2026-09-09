import test from 'node:test';
import assert from 'node:assert/strict';
import { documentHref, parseRoute, createNavigation, loadCurrentFile } from '../public/navigation.js';

test('same-document and cross-document anchors survive route encoding and refresh parsing', () => {
  const current = '任务/verify/manual-final.md';
  for (const [href, kind, path, anchor] of [
    ['#11-文档创建时间', 'file', current, '11-文档创建时间'],
    ['../README.md#目标与边界', 'plan', '任务', '目标与边界'],
    ['../other%20task.md#hello-world', 'file', '任务/other task.md', 'hello-world'],
  ]) {
    const route = documentHref(current, href);
    assert.deepEqual(parseRoute(route), { kind, path, anchor });
    assert.deepEqual(parseRoute(String(route)), { kind, path, anchor });
  }
  assert.equal(documentHref('任务/README.md', '../README.md'), '#/');
});

test('invalid or outside links cannot become document routes', () => {
  for (const href of ['../../outside.md', '/outside.md', 'https://example.com/a.md', 'javascript:a.md', '%2foutside.md', '%E0.md']) {
    assert.equal(documentHref('task/README.md', href), null, href);
  }
  assert.equal(parseRoute('#/file/%E0').kind, 'invalid');
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const response = (text) => ({ ok: true, json: async () => ({ markdown: text }) });

test('slow document A cannot replace B even when transport ignores abort', async () => {
  const nav = createNavigation();
  const a = deferred();
  const ticketA = nav.begin();
  const resultA = loadCurrentFile('a.md', ticketA, () => a.promise);
  const ticketB = nav.begin();
  assert.equal(ticketA.signal.aborted, true);
  assert.deepEqual(await loadCurrentFile('b.md', ticketB, async () => response('B')), { markdown: 'B' });
  a.resolve(response('A'));
  assert.equal(await resultA, null);
});

test('returning home invalidates a pending file and its error response', async () => {
  const nav = createNavigation();
  const pending = deferred();
  const result = loadCurrentFile('a.md', nav.begin(), () => pending.promise);
  nav.begin();
  pending.reject(new Error('late error'));
  assert.equal(await result, null);
});

test('navigation during response body parsing also invalidates the result', async () => {
  const nav = createNavigation();
  const body = deferred();
  const result = loadCurrentFile('a.md', nav.begin(), async () => ({ ok: true, json: () => body.promise }));
  await Promise.resolve();
  nav.begin();
  body.resolve({ markdown: 'A' });
  assert.equal(await result, null);
});

test('current request failures still report their real errors', async () => {
  await assert.rejects(loadCurrentFile('absent.md', createNavigation().begin(), async () => ({ ok: false, json: async () => ({ error: 'missing' }) })), /missing/);
});
