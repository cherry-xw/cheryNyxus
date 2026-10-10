export type LoginState = 'unauthenticated' | 'authenticating' | 'authenticated'
type LoginConnectionStatus = 'connected' | 'connecting' | 'disconnected'

export function resolveLoginState(input: {
  isRemote: boolean
  loggedIn: boolean
  connectionStatus: LoginConnectionStatus
  authenticating: boolean
}): LoginState {
  if (input.authenticating) return 'authenticating'
  if (input.isRemote && !input.loggedIn) return 'unauthenticated'
  if (input.connectionStatus !== 'connected') return 'authenticating'
  return 'authenticated'
}
