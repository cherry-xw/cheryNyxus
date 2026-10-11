#!/usr/bin/env node
/** Shared plan audit CLI; reports differences without writing files. */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditPlans } from './audit.mjs';

function options(argv) {
  const result = { json: false, strict: false, planDir: process.env.PLAN_DIR || null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') result.json = true;
    else if (arg === '--strict') result.strict = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--plan-dir' || arg.startsWith('--plan-dir=') || arg === '--repo-root' || arg.startsWith('--repo-root=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 需要路径`);
      result[arg.startsWith('--plan-dir') ? 'planDir' : 'repoRoot'] = path.resolve(value);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!result.planDir) {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = path.join(dir, 'docs/plan');
      if (existsSync(candidate)) { result.planDir = candidate; break; }
      const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
    }
    result.planDir ||= path.resolve('docs/plan');
  }
  return result;
}
try {
  const opts = options(process.argv.slice(2));
  if (opts.help) console.log('用法：node lint.mjs [--plan-dir=<目录>] [--repo-root=<项目根>] [--json] [--strict]\n退出码：0 无阻断错误；1 检查失败；2 参数或执行失败。严格模式也阻断待核对项。');
  else {
    const report = auditPlans(opts);
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      const { registered, directories, errors, warnings } = report.summary;
      console.log(`Plan 检查：总入口 ${registered} 项、计划目录 ${directories} 个；阻断错误 ${errors}，待核对 ${warnings}`);
      for (const issue of report.issues) console.log(`${issue.severity === 'error' ? '错误' : '待核对'} ${issue.code} ${issue.path}:${issue.line} ${issue.message}\n  预期：${issue.expected}\n  实际：${issue.actual}\n  处理：${issue.action}`);
    }
    if (report.summary.errors || (opts.strict && report.summary.warnings)) process.exitCode = 1;
  }
} catch (error) { console.error(String(error.message || error)); process.exitCode = 2; }
