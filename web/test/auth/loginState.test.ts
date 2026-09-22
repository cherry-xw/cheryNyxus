import { describe, expect, it } from 'vitest'
import { resolveLoginState } from '../../src/domain/auth/loginState'

describe('unified login state', () => {
  it('keeps an unauthenticated remote user out of the authenticated state', () => {
    expect(
      resolveLoginState({
        isRemote: true,
        loggedIn: false,
        connectionStatus: 'connected',
        authenticating: false,
      }),
    ).toBe('unauthenticated')
  })

  it('uses authenticating while login or connection completion is pending', () => {
    expect(
      resolveLoginState({
        isRemote: true,
        loggedIn: false,
        connectionStatus: 'disconnected',
        authenticating: true,
      }),
    ).toBe('authenticating')
    expect(
      resolveLoginState({
        isRemote: true,
        loggedIn: true,
        connectionStatus: 'connecting',
        authenticating: false,
      }),
    ).toBe('authenticating')
  })

  it('only reports authenticated after credentials and connection are ready', () => {
    expect(
      resolveLoginState({
        isRemote: true,
        loggedIn: true,
        connectionStatus: 'connected',
        authenticating: false,
      }),
    ).toBe('authenticated')
  })
})
