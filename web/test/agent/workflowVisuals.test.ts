import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WORKFLOW_HEADER_TEMPLATE } from '../../src/features/agent/workbench/runtime-diagram/headerTemplate'
import {
  headerVisual,
  resultVisual,
  statusIcon,
} from '../../src/features/agent/workbench/runtime-diagram/workflowVisuals'

describe('workflow visual identity and interaction contracts', () => {
  it('keeps every header capability visually identifiable before state styling', () => {
    const identities = WORKFLOW_HEADER_TEMPLATE.nodes.map((node) => headerVisual(node))
    const byCapability = new Map(identities.map((identity) => [identity.capability, identity]))

    expect(byCapability.size).toBeGreaterThanOrEqual(7)
    expect(new Set([...byCapability.values()].map((identity) => identity.accent)).size)
      .toBe(byCapability.size)
    expect(new Set([...byCapability.values()].map((identity) => identity.shape)).size)
      .toBe(byCapability.size)
  })

  it('keeps result capabilities and semantic states distinct', () => {
    const kinds = ['input', 'message', 'tool', 'branch', 'return', 'group', 'system'] as const
    const identities = kinds.map(resultVisual)
    expect(new Set(identities.map((identity) => identity.accent)).size).toBe(kinds.length)
    expect(statusIcon('running')).not.toBe(statusIcon('succeeded'))
    expect(statusIcon('waiting')).not.toBe(statusIcon('failed'))
  })

  it('uses Morphicons, an independent Info trigger and a live-only CRT mount', () => {
    const directory = resolve('web/src/features/agent/workbench/runtime-diagram')
    const morph = readFileSync(resolve(directory, 'WorkflowMorphIcon.vue'), 'utf8')
    const step = readFileSync(resolve(directory, 'WorkflowHeaderStepNode.vue'), 'utf8')

    expect(morph).toContain("from 'morphicons/vue'")
    expect(morph).toContain("? 'user' : 'always'")
    expect(step).toContain('class="workflow-step-info-button nodrag nopan"')
    expect(step).toContain('@pointerenter="openInfo"')
    expect(step).toContain('@focus="focusInfo"')
    expect(step).toContain('bottom: calc(100% + 8px)')
    expect(step).toContain('<WorkflowLiveCrt v-if="data.liveTurn"')
    expect(step).toContain('@click.stop="selectStep"')
  })
})
