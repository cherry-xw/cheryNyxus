import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ManagedAppError } from './types.ts'
const run = promisify(execFile)
const uploadAction = '290001'
const downloadAction = '290002'

// Shared kernel policers count all managed veth traffic together.
export async function initializeApplicationNetworkLimits(): Promise<void> {
  for (const index of [uploadAction, downloadAction]) await run('tc', ['actions', 'replace', 'action', 'police', 'rate', '41943040bit', 'burst', '64k', 'conform-exceed', 'drop/pipe', 'index', index], { timeout: 5000 })
}

export function applicationNetworkCommands(device: string, policeIndex?: number): string[][] {
  if (!/^veth[a-f0-9]{1,15}$/.test(device)) throw new ManagedAppError('INVALID_INPUT', '应用网络接口无效')
  if (policeIndex !== undefined && (!Number.isSafeInteger(policeIndex) || policeIndex < 1 || [290001, 290002].includes(policeIndex))) throw new ManagedAppError('INVALID_INPUT', '应用限速动作无效')
  const police = ['action', 'police', 'rate', '16777216bit', 'burst', '32k', 'conform-exceed', 'drop/pipe']
  return [
    ...(policeIndex === undefined ? [] : [['actions', 'replace', ...police, 'index', String(policeIndex)]]),
    ['qdisc', 'replace', 'dev', device, 'root', 'tbf', 'rate', '16777216bit', 'burst', '32k', 'latency', '100ms'],
    ['filter', 'replace', 'dev', device, 'ingress', 'protocol', 'all', 'prio', '10', 'handle', '1', 'matchall', ...(policeIndex === undefined ? police : ['action', 'police', 'index', String(policeIndex)]), 'action', 'police', 'index', uploadAction],
    ['filter', 'replace', 'dev', device, 'egress', 'protocol', 'all', 'prio', '10', 'handle', '1', 'matchall', 'action', 'police', 'index', downloadAction],
  ]
}

export async function limitApplicationNetwork(containerName: string): Promise<void> {
  if (!/^chery-app-[a-z0-9-]+$/.test(containerName)) throw new ManagedAppError('INVALID_INPUT', '应用容器名无效')
  const pidResult = await run('docker', ['inspect', containerName, '--format', '{{.State.Pid}}|{{index .Config.Labels "chery.managed.app"}}'], { timeout: 5000 })
  const [pidText, managed] = pidResult.stdout.trim().split('|')
  if (managed !== 'true') throw new ManagedAppError('APP_ACCESS_DENIED', '禁止操作非受管容器的网络')
  const pid = Number(pidText)
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '应用网络命名空间不可用')
  const inside = await run('nsenter', ['--target', String(pid), '--net', '--', 'ip', '-j', 'link', 'show', 'dev', 'eth0'], { timeout: 5000 })
  const peerIndex = (JSON.parse(inside.stdout) as Array<{ link_index?: number }>)[0]?.link_index
  const outside = await run('ip', ['-j', 'link', 'show'], { timeout: 5000 })
  const device = (JSON.parse(outside.stdout) as Array<{ ifindex: number; ifname: string }>).find(link => link.ifindex === peerIndex)?.ifname
  if (!device) throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '找不到应用专用网络接口')
  const qdisc = await run('tc', ['qdisc', 'show', 'dev', device], { timeout: 5000 })
  if (!qdisc.stdout.includes('clsact')) await run('tc', ['qdisc', 'add', 'dev', device, 'clsact'], { timeout: 5000 })
  // Reuse the private policer already bound to this exact filter. Replacing a
  // filter with a newly auto-allocated inline policer fails with EEXIST.
  const existing = await run('tc', ['-j', 'filter', 'show', 'dev', device, 'ingress'], { timeout: 5000 })
  const filters = JSON.parse(existing.stdout || '[]') as Array<{ pref?: number; kind?: string; options?: { handle?: number; actions?: Array<{ kind?: string; index?: number }> } }>
  const filter = filters.find(f => f.pref === 10 && f.kind === 'matchall' && f.options?.handle === 1)
  const index = filter?.options?.actions?.find(a => a.kind === 'police' && a.index !== 290001 && a.index !== 290002)?.index
  const actions = filter?.options?.actions ?? []
  if (filter && (actions.length !== 2 || !index || actions[0]?.index !== index || actions[1]?.kind !== 'police' || actions[1]?.index !== 290001))
    throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '已有应用上传限速规则不符合预期，拒绝替换')
  const outgoing = await run('tc', ['-j', 'filter', 'show', 'dev', device, 'egress'], { timeout: 5000 })
  const egress = (JSON.parse(outgoing.stdout || '[]') as typeof filters).find(f => f.pref === 10 && f.kind === 'matchall' && f.options?.handle === 1)
  if (egress && (egress.options?.actions?.length !== 1 || egress.options.actions[0]?.kind !== 'police' || egress.options.actions[0]?.index !== 290002))
    throw new ManagedAppError('CONTROLLER_UNAVAILABLE', '已有应用下载限速规则不符合预期，拒绝替换')
  const commands = applicationNetworkCommands(device, index)
  for (const args of commands) {
    // matchall does not support replacing this existing filter on the host
    // kernel. Keep the verified bindings; update only their police action.
    if (args[0] === 'filter' && ((args.includes('ingress') && filter) || (args.includes('egress') && egress))) continue
    await run('tc', args, { timeout: 5000 })
  }
}
