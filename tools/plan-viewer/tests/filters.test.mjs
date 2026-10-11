import test from 'node:test';
import assert from 'node:assert/strict';
import { filterPlans, filterIssues } from '../public/filters.js';

test('task filters combine stage, attention and searchable text without mutating the source', () => {
  const plans = [
    { name: 'Beta', dir: 'beta', status: '执行中', scope: '图片', issues: [] },
    { name: 'Alpha', dir: 'alpha', status: '执行中', scope: 'QQ 能力', issues: [{ severity: 'warning' }] },
    { name: 'Gamma', dir: 'gamma', status: '规划中', scope: 'QQ 能力', issues: [{ severity: 'error' }] },
  ];
  assert.deepEqual(filterPlans(plans).map((plan) => plan.dir), ['gamma', 'alpha', 'beta']);
  assert.deepEqual(filterPlans(plans, { query: 'qq', status: '执行中', attention: true }).map((plan) => plan.dir), ['alpha']);
  assert.deepEqual(plans.map((plan) => plan.dir), ['beta', 'alpha', 'gamma']);
});

test('difference filters find descriptions, paths and checks within severity', () => {
  const issues = [
    { severity: 'error', message: '状态不同', path: 'task/README.md', code: 'STATUS_MISMATCH' },
    { severity: 'warning', message: '资料待核对', path: 'task/verify/check.md', code: 'RECOVERY_POINT' },
  ];
  assert.deepEqual(filterIssues(issues, { query: 'readme', severity: 'error' }), [issues[0]]);
  assert.deepEqual(filterIssues(issues, { query: 'recovery', severity: 'warning' }), [issues[1]]);
  assert.deepEqual(filterIssues(issues, { query: 'readme', severity: 'warning' }), []);
});
