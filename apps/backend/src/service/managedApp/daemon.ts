import { ManagedAppController } from './controller.ts'
import {
  DEFAULT_CONTROLLER_SOCKET_PATH,
  startControllerSocketServer,
} from './socketRpc.ts'

export async function runControllerDaemon(): Promise<void> {
  const socketPath =
    process.env.CHERY_APP_CONTROLLER_SOCKET ?? DEFAULT_CONTROLLER_SOCKET_PATH
  const controller = new ManagedAppController({
    stateFilePath: process.env.CHERY_APP_STATE_FILE,
    xfsMountPoint: process.env.CHERY_APP_XFS_MOUNT,
    hostUserFilesRoot: process.env.CHERY_APP_HOST_USER_FILES_ROOT,
    parentCgroupDir: process.env.CHERY_APP_PARENT_CGROUP_DIR,
    systemdSliceName: process.env.CHERY_APP_SYSTEMD_SLICE,
    dockerNetworkName: process.env.CHERY_APP_DOCKER_NETWORK,
    runtimeImage: process.env.CHERY_APP_RUNTIME_IMAGE,
    templateSkeletonHostPath: process.env.CHERY_APP_TEMPLATE_SKELETON,
  })

  await controller.init()
  const { close } = await startControllerSocketServer(controller, socketPath)
  console.log(
    `[cheryNyxus-app-controller] listening on unix://${socketPath} (slice=${process.env.CHERY_APP_SYSTEMD_SLICE ?? 'cherynyxus-apps.slice'})`,
  )

  let sweeping = false
  const timer = setInterval(() => {
    if (sweeping) return
    sweeping = true
    void controller.sweepLifecycle().catch(() => console.error('[cheryNyxus-app-controller] lifecycle sweep failed')).finally(() => { sweeping = false })
  }, 60_000)
  timer.unref()
  const shutdown = async () => {
    clearInterval(timer)
    console.log('[cheryNyxus-app-controller] shutting down...')
    await close()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith('daemon.ts') ||
    process.argv[1].endsWith('daemon.mjs') ||
    process.argv[1].endsWith('controller-daemon.mjs'))
) {
  runControllerDaemon().catch(err => {
    console.error('[cheryNyxus-app-controller] fatal startup error:', err)
    process.exit(1)
  })
}
