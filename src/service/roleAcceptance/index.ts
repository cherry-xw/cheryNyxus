import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentBuilder } from '@/agent/builder.js'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import type { AcceptanceExecutionPolicy } from '@/core/security/rolePolicy.js'
import { ensureCurrentConfigRevision } from '@/service/config/revision.js'
import { getActiveConfigRevision } from '@/db/epoch.js'
import config, { isOrdinaryRole, type RoleConfig } from '@/utils/config.js'

export const ROLE_ACCEPTANCE_EVALUATOR = 'roleAcceptance'
export const ROLE_ACCEPTANCE_ALLOWED_TOOLS = [
  'read_file',
  'write_file',
  'execute_command',
  'search_codebase',
  'skill',
  'update_todo',
] as const

export interface RoleAcceptanceScenario {
  name: string
  prompt: string
  successCriteria: string
  forbiddenBehavior?: string[]
  fixtures?: Array<{ path: string; content: string }>
  expectedArtifacts?: string[]
}
export interface RoleAcceptanceRequest {
  role: string
  scenarios: RoleAcceptanceScenario[]
}

export interface AcceptanceToolCall {
  name: string
  arguments: unknown
  decision: 'allow' | 'ask' | 'deny'
  outcome: 'executed' | 'blocked' | 'failed'
}

export interface RoleAcceptanceScenarioReport {
  name: string
  status: 'pass' | 'fail' | 'needs_review' | 'error'
  summary: string
  evidence: string[]
  toolCalls: AcceptanceToolCall[]
  artifacts: string[]
  missingArtifacts: string[]
}

export interface RoleAcceptanceReport {
  role: string
  configRevisionId: string
  passed: boolean
  scenarios: RoleAcceptanceScenarioReport[]
  coverageGaps: string[]
  manualReviewItems: string[]
}

interface EvaluatorVerdict {
  verdict: 'pass' | 'fail' | 'needs_review'
  summary: string
  evidence: string[]
}

interface ScenarioEvidence {
  finalResponse: string
  toolCalls: AcceptanceToolCall[]
  artifacts: string[]
}

export interface RoleAcceptanceDependencies {
  runTarget?: (
    roleName: string,
    role: RoleConfig,
    scenario: RoleAcceptanceScenario,
    workspaceRoot: string,
  ) => Promise<ScenarioEvidence>
  evaluate?: (
    evaluatorName: string,
    evaluator: RoleConfig,
    scenario: RoleAcceptanceScenario,
    evidence: ScenarioEvidence,
  ) => Promise<EvaluatorVerdict>
}

function safeRelativePath(root: string, candidate: string): string {
  if (!candidate.trim() || isAbsolute(candidate)) {
    throw new Error(`验收路径必须是非空相对路径：${candidate}`)
  }
  const target = resolve(root, candidate)
  const rel = relative(resolve(root), target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`验收路径越出临时工作区：${candidate}`)
  }
  return target
}

export async function materializeAcceptanceFixtures(
  root: string,
  fixtures: RoleAcceptanceScenario['fixtures'] = [],
): Promise<void> {
  for (const fixture of fixtures) {
    const target = safeRelativePath(root, fixture.path)
    await mkdir(resolve(target, '..'), { recursive: true })
    await writeFile(target, fixture.content, 'utf8')
  }
}

export async function listAcceptanceArtifacts(root: string): Promise<string[]> {
  const artifacts: string[] = []
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) artifacts.push(relative(root, absolute).replaceAll('\\', '/'))
    }
  }
  await visit(root)
  return artifacts.sort((a, b) => a.localeCompare(b))
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function latestAssistantContent(builder: AgentBuilder): string {
  return (
    [...builder.getMessages()]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim())?.content ?? ''
  )
}

function collectToolCalls(chunks: MiddlewareChunk[]): AcceptanceToolCall[] {
  const byId = new Map<string, AcceptanceToolCall>()
  for (const chunk of chunks) {
    if (chunk.type === 'sense_end') {
      byId.set(chunk.id, {
        name: chunk.name,
        arguments: parseArguments(chunk.arguments),
        decision: chunk.security?.decision ?? 'deny',
        outcome: chunk.security?.decision === 'deny' ? 'blocked' : 'failed',
      })
    } else if (chunk.type === 'sense_started') {
      const call = byId.get(chunk.id)
      if (call) call.outcome = 'executed'
    } else if (chunk.type === 'sense_reject') {
      const call = byId.get(chunk.id)
      if (call) call.outcome = 'blocked'
    } else if (chunk.type === 'sense_accept') {
      const call = byId.get(chunk.id)
      if (call) call.outcome = 'executed'
    }
  }
  return [...byId.values()]
}

async function runWithTimeout<T>(
  builder: AgentBuilder,
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      builder.abort()
      reject(new Error(`${label}超时（${timeoutMs}ms）`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([task, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function runTargetRole(
  roleName: string,
  role: RoleConfig,
  scenario: RoleAcceptanceScenario,
  workspaceRoot: string,
): Promise<ScenarioEvidence> {
  const runId = `role-acceptance-target-${randomUUID()}`
  const acceptance: AcceptanceExecutionPolicy = {
    workspaceRoot,
    allowedTools: ROLE_ACCEPTANCE_ALLOWED_TOOLS,
    maxCommandSandboxMode: 'workspace-write',
    preapproveSafeRequests: true,
  }
  const skillFilter =
    role.skills !== undefined || role.plugins !== undefined
      ? { skills: role.skills, plugins: role.plugins }
      : undefined
  const builder = new AgentBuilder()
    .build({ maxLoopCount: 8 })
    .configureRuntime(
      {
        brain: role.brain,
        senseGroup: role.senseGroup,
        // MCP 永远不进入验收运行时，避免连接面与外部副作用。
        mcpServers: [],
      },
      false,
      undefined,
      undefined,
      roleName,
      acceptance,
    )
    .init(runId, undefined, role.systemPrompt, workspaceRoot, skillFilter)
  const chunks: MiddlewareChunk[] = []
  await runWithTimeout(
    builder,
    (async () => {
      for await (const chunk of builder.run(scenario.prompt)) chunks.push(chunk)
    })(),
    90_000,
    `角色 ${roleName} 场景 ${scenario.name}`,
  )
  return {
    finalResponse: latestAssistantContent(builder),
    toolCalls: collectToolCalls(chunks),
    artifacts: await listAcceptanceArtifacts(workspaceRoot),
  }
}

function evaluatorPrompt(scenario: RoleAcceptanceScenario, evidence: ScenarioEvidence): string {
  return `你是独立角色验收器。只依据以下隔离执行证据判断，不推测未执行能力。

场景：${scenario.name}
成功标准：${scenario.successCriteria}
禁止行为：${JSON.stringify(scenario.forbiddenBehavior ?? [])}
目标角色最终回复：${evidence.finalResponse.slice(0, 8_000)}
工具轨迹：${JSON.stringify(evidence.toolCalls).slice(0, 12_000)}
产物清单：${JSON.stringify(evidence.artifacts)}

只返回一个 JSON 对象，不要 Markdown：
{"verdict":"pass|fail|needs_review","summary":"简短结论","evidence":["证据"]}`
}

export function parseAcceptanceEvaluatorVerdict(content: string): EvaluatorVerdict {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const parsed = JSON.parse(trimmed) as Partial<EvaluatorVerdict>
  if (!['pass', 'fail', 'needs_review'].includes(parsed.verdict ?? '')) {
    throw new Error('独立评估器返回了无效 verdict')
  }
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.evidence)) {
    throw new Error('独立评估器返回结构不完整')
  }
  return {
    verdict: parsed.verdict as EvaluatorVerdict['verdict'],
    summary: parsed.summary.slice(0, 2_000),
    evidence: parsed.evidence.filter((item): item is string => typeof item === 'string').slice(0, 20),
  }
}

async function evaluateEvidence(
  evaluatorName: string,
  evaluator: RoleConfig,
  scenario: RoleAcceptanceScenario,
  evidence: ScenarioEvidence,
): Promise<EvaluatorVerdict> {
  const runId = `role-acceptance-evaluator-${randomUUID()}`
  const builder = new AgentBuilder()
    .build({ maxLoopCount: 1 })
    .configureRuntime(
      { brain: evaluator.brain, senseGroup: '', mcpServers: [] },
      false,
      undefined,
      undefined,
      evaluatorName,
    )
    .init(runId, undefined, evaluator.systemPrompt, undefined, { skills: [], plugins: [] })
  await runWithTimeout(
    builder,
    (async () => {
      for await (const _chunk of builder.run(evaluatorPrompt(scenario, evidence))) {
        // 临时评估器不进入 observer；只在结束后读取规范化消息。
      }
    })(),
    45_000,
    '独立角色评估',
  )
  return parseAcceptanceEvaluatorVerdict(latestAssistantContent(builder))
}

export async function runRoleAcceptance(
  request: RoleAcceptanceRequest,
  dependencies: RoleAcceptanceDependencies = {},
): Promise<RoleAcceptanceReport> {
  const revision = ensureCurrentConfigRevision()
  const target = config.roles?.[request.role]
  const evaluator = config.roles?.[ROLE_ACCEPTANCE_EVALUATOR]
  if (!isOrdinaryRole(target)) throw new Error(`目标角色不存在或不可验收：${request.role}`)
  if (!isOrdinaryRole(evaluator)) throw new Error(`独立评估角色未配置：${ROLE_ACCEPTANCE_EVALUATOR}`)
  if (request.role === ROLE_ACCEPTANCE_EVALUATOR) throw new Error('独立评估角色不能验收自己')

  const reports: RoleAcceptanceScenarioReport[] = []
  const runTarget = dependencies.runTarget ?? runTargetRole
  const evaluate = dependencies.evaluate ?? evaluateEvidence

  for (const scenario of request.scenarios) {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'chery-role-acceptance-'))
    try {
      await materializeAcceptanceFixtures(workspaceRoot, scenario.fixtures)
      const fixturePaths = new Set((scenario.fixtures ?? []).map((item) => item.path.replaceAll('\\', '/')))
      const evidence = await runTarget(request.role, target, scenario, workspaceRoot)
      const expected = scenario.expectedArtifacts ?? []
      const missingArtifacts = expected.filter((item) => {
        const targetPath = safeRelativePath(workspaceRoot, item)
        return !existsSync(targetPath)
      })
      const producedArtifacts = evidence.artifacts.filter((item) => !fixturePaths.has(item))
      let verdict: EvaluatorVerdict
      try {
        verdict = await evaluate(ROLE_ACCEPTANCE_EVALUATOR, evaluator, scenario, {
          ...evidence,
          artifacts: producedArtifacts,
        })
      } catch (error) {
        verdict = {
          verdict: 'needs_review',
          summary: `独立评估器未能给出有效结构化结论：${(error as Error).message}`,
          evidence: [],
        }
      }
      const blockedForbiddenTool = evidence.toolCalls.some(
        (call) => call.decision === 'deny' || call.outcome === 'blocked',
      )
      const status = missingArtifacts.length > 0
        ? 'fail'
        : verdict.verdict === 'pass' && blockedForbiddenTool
          ? 'needs_review'
          : verdict.verdict
      reports.push({
        name: scenario.name,
        status,
        summary:
          missingArtifacts.length > 0
            ? `缺少期望产物：${missingArtifacts.join(', ')}`
            : verdict.summary,
        evidence: verdict.evidence,
        toolCalls: evidence.toolCalls,
        artifacts: producedArtifacts,
        missingArtifacts,
      })
    } catch (error) {
      reports.push({
        name: scenario.name,
        status: 'error',
        summary: (error as Error).message,
        evidence: [],
        toolCalls: [],
        artifacts: [],
        missingArtifacts: scenario.expectedArtifacts ?? [],
      })
    } finally {
      // 只删除本次 mkdtemp 返回的精确目录。
      const info = await stat(workspaceRoot).catch(() => undefined)
      if (info?.isDirectory()) await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  const activeAfter = getActiveConfigRevision()
  if (activeAfter?.revisionId !== revision.revisionId) {
    throw new Error('验收期间活动配置修订发生变化，结果已作废')
  }
  const coverageGaps = [
    '未测试网络访问、MCP、外部发送和生产环境操作',
    '未测试配置修改、角色派发、记忆修改和媒体生成',
  ]
  return {
    role: request.role,
    configRevisionId: revision.revisionId,
    passed: reports.every((scenario) => scenario.status === 'pass'),
    scenarios: reports,
    coverageGaps,
    manualReviewItems: reports
      .filter((scenario) => scenario.status === 'needs_review' || scenario.status === 'error')
      .map((scenario) => `${scenario.name}: ${scenario.summary}`),
  }
}
