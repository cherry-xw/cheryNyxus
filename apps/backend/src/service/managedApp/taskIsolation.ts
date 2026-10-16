import { spawn } from 'node:child_process'
import path from 'node:path'
import { readFileSync } from 'node:fs'

/** Root-only controller bootstrap. Workload privileges are dropped before any user code. */
export function isolatedTaskArgs(containerPid: number, workdir: string, command: string): string[] {
  if (!Number.isSafeInteger(containerPid) || containerPid <= 1) throw new Error('Invalid container PID')
  return [
    '--target', String(containerPid), '--mount', '--uts', '--ipc', '--net', '--root',
    '--no-fork', `--wdns=${workdir}`, '--',
    'unshare', '--mount', '--pid', '--fork', '--kill-child=SIGKILL', '--mount-proc',
    'setpriv', '--pdeathsig=SIGKILL', 'sh', '-c',
    'setpriv --reuid=1000 --regid=1000 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs sh -c "$1" & child=$!; wait "$child"; exit $?',
    'task-init', command,
  ]
}

export function spawnIsolatedTask(containerPid: number, workdir: string, command: string) {
  if (process.getuid?.() !== 0) throw new Error('Task isolation requires the host root controller')
  // nsenter execs unshare in-place; this host PID is a privileged supervisor, never user code.
  // Killing it kills namespace init; Linux then kills every process in that PID namespace.
  const entry = readFileSync(`/proc/${containerPid}/cgroup`, 'utf8').trim()
  if (!entry.startsWith('0::/')) throw new Error('Task isolation requires cgroup v2')
  const cgroup = path.resolve('/sys/fs/cgroup', `.${entry.slice(3)}`)
  if (!cgroup.startsWith('/sys/fs/cgroup/cherynyxus.slice/cherynyxus-apps.slice/docker-')) {
    throw new Error('Container is outside the managed application slice')
  }
  return spawn('sh', ['-c', 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit; shift; exec "$@"',
    'task-bootstrap', cgroup, 'nsenter', ...isolatedTaskArgs(containerPid, workdir, command)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', NODE_ENV: 'production', NODE_PATH: '/opt/chery-app-template/node_modules', PORT: '3000' },
  })
}
