import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveShellExecutable, spawnSandboxedCommand } from '@/core/security/sandbox.js'

const created: string[] = []
function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  created.push(path)
  return path
}
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function wait(child: ReturnType<typeof spawnSandboxedCommand>): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    child.process.once('error', reject)
    child.process.once('close', (code) => {
      child.cleanup()
      resolve(code)
    })
  })
}

describe.runIf(process.platform === 'win32')('Windows ACL 命令沙箱', () => {
  it('workspace-write 只允许工作区内写入', async () => {
    const workspace = temp('chery-sandbox-workspace-')
    const outside = temp('chery-sandbox-outside-')
    const shell = resolveShellExecutable('powershell')
    const insideFile = join(workspace, 'inside.txt')
    const inside = spawnSandboxedCommand({
      executable: shell.executable,
      args: [...shell.args, `Set-Content -LiteralPath '${insideFile.replaceAll("'", "''")}' -Value ok`],
      cwd: workspace,
      workspaceRoot: workspace,
      mode: 'workspace-write',
    })
    expect(await wait(inside)).toBe(0)
    expect(readFileSync(insideFile, 'utf8')).toContain('ok')

    const outsideFile = join(outside, 'outside.txt')
    const denied = spawnSandboxedCommand({
      executable: shell.executable,
      args: [...shell.args, `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${outsideFile.replaceAll("'", "''")}' -Value denied`],
      cwd: workspace,
      workspaceRoot: workspace,
      mode: 'workspace-write',
    })
    expect(await wait(denied)).not.toBe(0)
    expect(existsSync(outsideFile)).toBe(false)
  }, 30_000)
})
