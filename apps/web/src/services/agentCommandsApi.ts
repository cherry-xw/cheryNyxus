import type { AgentCommandMethodMap } from '@chery/protocol'
import { call } from './agentApiTransport'

function commandCall<K extends keyof AgentCommandMethodMap>(method: K, params: AgentCommandMethodMap[K]['params']) {
  return call<AgentCommandMethodMap[K]['result']>(method, params)
}

export const agentCommandsApi = {
  list: (params: AgentCommandMethodMap['agent.command.list']['params']) => commandCall('agent.command.list', params),
  get: (commandId: string) => commandCall('agent.command.get', { commandId }),
  logs: (params: AgentCommandMethodMap['agent.command.logs.read']['params']) => commandCall('agent.command.logs.read', params),
  stop: (commandId: string) => commandCall('agent.command.stop', { commandId }),
  subscribe: (params: AgentCommandMethodMap['agent.command.subscribe']['params']) => commandCall('agent.command.subscribe', params),
  unsubscribe: (subscriptionId: string) => commandCall('agent.command.unsubscribe', { subscriptionId }),
}
