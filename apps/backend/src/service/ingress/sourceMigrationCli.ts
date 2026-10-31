import { runSourceMigrationCommand } from './sourceMigrationCommand.js'

try {
  const report = runSourceMigrationCommand(process.argv.slice(2))
  console.log(JSON.stringify(report))
  if (report.conflicts.length) process.exitCode = 1
} catch {
  // Maintenance errors may contain private paths or source content.
  console.error('QQ source migration failed; verify offline state, arguments and recovery backup.')
  process.exitCode = 1
}
