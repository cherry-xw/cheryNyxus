import { runQuestionMaintenance } from './questionMaintenance.js'

try {
  const report = runQuestionMaintenance(process.argv.slice(2))
  console.log(JSON.stringify(report))
  if (report.conflicts.length) process.exitCode = 1
} catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z_]{2,80}$/.test(error.message) ? error.message : 'QUESTION_MAINTENANCE_FAILED'
  console.error(code)
  process.exitCode = 1
}
