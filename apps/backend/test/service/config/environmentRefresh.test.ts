import { afterEach, describe, expect, it } from 'vitest'
import { captureRuntimeConfig, getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import {
  getConfigApplyCoordinator,
  readConfigImage,
  submitEnvironmentRefresh,
} from '@/service/config/commit.js'

describe('environment config refresh', () => {
  const baseline = getAppliedRawConfig()
  const envName = 'CHERY_TEST_ROTATED_KEY'

  afterEach(() => {
    delete process.env[envName]
    replaceRuntimeConfig(baseline)
  })

  it('re-resolves an unchanged placeholder on rotation and removal', async () => {
    const image = readConfigImage()
    const brain = Object.keys(image.config.llm.brain)[0]!
    image.config.llm.brain[brain]!.key = `$${envName}`
    process.env[envName] = 'first-secret-value'
    submitEnvironmentRefresh(image, [envName])
    await getConfigApplyCoordinator().retry()
    expect(captureRuntimeConfig().llm.brain[brain]!.key).toBe('first-secret-value')

    process.env[envName] = 'second-secret-value'
    submitEnvironmentRefresh(image, [envName])
    await getConfigApplyCoordinator().retry()
    expect(captureRuntimeConfig().llm.brain[brain]!.key).toBe('second-secret-value')

    delete process.env[envName]
    submitEnvironmentRefresh(image, [envName])
    await getConfigApplyCoordinator().retry()
    expect(captureRuntimeConfig().llm.brain[brain]!.key).toBe(`$${envName}`)
  })

  it('keeps process-bound paths on the restart boundary', () => {
    const state = submitEnvironmentRefresh(readConfigImage(), ['CHERY_DIR'])
    expect(state.restart).toEqual({ required: true, status: 'pending' })
    expect(state.impacts.some((impact) => impact.boundary === 'restart')).toBe(true)
  })
})
