import type { QQServiceState } from '@chery/protocol'

export function serviceFixture(patch: Partial<QQServiceState> = {}): QQServiceState {
  return { selfId: '123', backendInstanceId: 'backend-fixture', operationId: null, version: 1, phase: 'running',
    targets: [{ conversationType: 'group', targetId: '456' }, { conversationType: 'private', targetId: '789' }], questions: [], ...patch }
}
