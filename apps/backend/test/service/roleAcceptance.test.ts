import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import config from '@/utils/config.js'
import {
  materializeAcceptanceFixtures,
  parseAcceptanceEvaluatorVerdict,
  runRoleAcceptance,
} from '@/service/roleAcceptance/index.js'

const originalRoles = config.roles

afterEach(() => {
  config.roles = originalRoles
})
describe('角色端到端验收服务', () => {
  it('拒绝越界夹具路径', async () => {
    await expect(
      materializeAcceptanceFixtures(process.cwd(), [{ path: '../outside.txt', content: 'x' }]),
    ).rejects.toThrow('越出临时工作区')
  })

  it('严格解析独立评估器 JSON', () => {
    expect(
      parseAcceptanceEvaluatorVerdict(
        '{"verdict":"pass","summary":"符合标准","evidence":["生成产物"]}',
      ),
    ).toEqual({ verdict: 'pass', summary: '符合标准', evidence: ['生成产物'] })
    expect(() => parseAcceptanceEvaluatorVerdict('{"verdict":"maybe"}')).toThrow()
  })

  it('物化夹具、校验产物并清理精确临时目录', async () => {
    config.roles = {
      ...originalRoles,
      acceptanceTarget: {
        brain: 'mock_content',
        senseGroup: 'auto_senses',
        mcpServers: [],
        permissions: { template: 'workspace-developer' },
      },
      roleAcceptance: {
        brain: 'mock_content',
        senseGroup: 'auto_senses',
        mcpServers: [],
      },
    }
    let capturedRoot = ''
    const report = await runRoleAcceptance(
      {
        role: 'acceptanceTarget',
        scenarios: [
          {
            name: '生成报告',
            prompt: '读取 input.txt 并生成 output.txt',
            successCriteria: 'output.txt 存在',
            fixtures: [{ path: 'input.txt', content: 'fixture' }],
            expectedArtifacts: ['output.txt'],
          },
        ],
      },
      {
        runTarget: async (_roleName, _role, _scenario, workspaceRoot) => {
          capturedRoot = workspaceRoot
          expect(existsSync(`${workspaceRoot}/input.txt`)).toBe(true)
          await writeFile(`${workspaceRoot}/output.txt`, 'done', 'utf8')
          return {
            finalResponse: '已生成 output.txt',
            toolCalls: [
              {
                name: 'write_file',
                arguments: { path: `${workspaceRoot}/output.txt` },
                decision: 'allow',
                outcome: 'executed',
              },
            ],
            artifacts: ['input.txt', 'output.txt'],
          }
        },
        evaluate: async () => ({
          verdict: 'pass',
          summary: '产物与回复符合标准',
          evidence: ['output.txt 已生成'],
        }),
      },
    )
    expect(report.passed).toBe(true)
    expect(report.scenarios[0]).toMatchObject({
      status: 'pass',
      artifacts: ['output.txt'],
      missingArtifacts: [],
    })
    expect(capturedRoot).toContain('chery-role-acceptance-')
    expect(existsSync(capturedRoot)).toBe(false)
  })

  it('期望产物缺失确定性覆盖评估器 pass', async () => {
    config.roles = {
      ...originalRoles,
      acceptanceTarget: { brain: 'mock_content', senseGroup: 'auto_senses' },
      roleAcceptance: { brain: 'mock_content', senseGroup: 'auto_senses' },
    }
    const report = await runRoleAcceptance(
      {
        role: 'acceptanceTarget',
        scenarios: [
          {
            name: '缺失产物',
            prompt: '生成 missing.txt',
            successCriteria: 'missing.txt 存在',
            expectedArtifacts: ['missing.txt'],
          },
        ],
      },
      {
        runTarget: async () => ({ finalResponse: '完成', toolCalls: [], artifacts: [] }),
        evaluate: async () => ({ verdict: 'pass', summary: '看似通过', evidence: [] }),
      },
    )
    expect(report.passed).toBe(false)
    expect(report.scenarios[0]?.status).toBe('fail')
    expect(report.scenarios[0]?.missingArtifacts).toEqual(['missing.txt'])
  })
})
