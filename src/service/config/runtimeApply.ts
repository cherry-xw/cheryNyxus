import { getAppliedRawConfig, prepareRuntimeConfig, publishRuntimeConfig } from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'
import { prepareHookRegistry, publishHookRegistry } from '@/agent/hooks/registry.js'
import { preparePresetSchedule } from '@/service/schedule/scheduler.js'
import type { ConfigApplyCoordinator } from './applyCoordinator.js'
import { resources, type ConfigImage } from './impact.js'
import { prepareSessionLifecycle, setConfigResource } from './sessionLifecycle.js'

/** Operation/run settings and chapter-05 local resources publish here. Tree,
 * restart and unsupported changes remain pending for their owning chapters. */
export function registerRuntimeConfigAdapters(
  coordinator: ConfigApplyCoordinator,
  image: ConfigImage,
): void {
  coordinator.registerTreeAdapter(prepareSessionLifecycle)
  const applied: ConfigImage = { config: getAppliedRawConfig(), hooks: {} }
  const candidates = new Map([...resources(applied), ...resources(image)])
  for (const [resource, entry] of candidates) {
    coordinator.register(resource, {
      async prepare({ after, impact }) {
        const [root, name, field] = entry.path
        const hookResource =
          root === 'hooks' ||
          (root === 'llm' && entry.path[3] === 'hooks') ||
          (root === 'assets' && name?.startsWith('hooks/'))
        if (hookResource) {
          const candidate = prepareHookRegistry(image.hooks, image.config.llm?.brain ?? {})
          return {
            unsafe: () => undefined,
            apply: () => publishHookRegistry(candidate),
            dispose: () => {},
          }
        }
        if (root === 'presets' && field === 'schedule') {
          const candidate = preparePresetSchedule(name!, after as never)
          return {
            unsafe: () => undefined,
            apply: candidate.apply,
            dispose: candidate.dispose,
          }
        }
        if (!['operation', 'run'].includes(impact.boundary)) {
          return {
            unsafe: () => '等待节点树安全边界',
            apply: () => {},
            dispose: () => {},
          }
        }
        const raw = getAppliedRawConfig()
        setConfigResource(raw, entry.path, after)
        const candidate = prepareRuntimeConfig(raw)
        return {
          unsafe: () => undefined,
          apply: () => {
            if (resource === '["global","logger"]') {
              logger.setConfig(candidate.config.global.logger ?? {})
            }
            publishRuntimeConfig(candidate)
          },
          dispose: () => {},
        }
      },
    })
  }
}
