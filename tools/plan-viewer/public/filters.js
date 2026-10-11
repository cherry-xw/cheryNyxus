/* Plan 控制台的纯筛选逻辑，不依赖浏览器。 */

const normalized = (value) => String(value ?? '').trim().toLocaleLowerCase();

export function filterPlans(plans, { query = '', status = 'all', attention = false } = {}) {
  const needle = normalized(query);
  return plans
    .filter((plan) => {
      if (status !== 'all' && plan.status !== status) return false;
      if (attention && !(plan.issues || []).length) return false;
      if (!needle) return true;
      return [plan.name, plan.dir, plan.scope, plan.goal].some((value) => normalized(value).includes(needle));
    })
    .sort((left, right) => {
      const priority = (plan) => (plan.issues || []).reduce((score, issue) => Math.max(score, issue.severity === 'error' ? 2 : 1), 0);
      return priority(right) - priority(left);
    });
}

export function filterIssues(issues, { query = '', severity = 'all' } = {}) {
  const needle = normalized(query);
  return issues.filter((issue) => {
    if (severity !== 'all' && issue.severity !== severity) return false;
    if (!needle) return true;
    return [issue.message, issue.path, issue.code, issue.expected, issue.actual, issue.action]
      .some((value) => normalized(value).includes(needle));
  });
}
