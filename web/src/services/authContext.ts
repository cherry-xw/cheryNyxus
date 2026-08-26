/** Read-only runtime auth dependency injected by the application composition root. */
export interface ServiceAuthPort {
  isRemote: () => boolean
  baseUrl: () => string
  accessToken: () => string
  headers: () => Record<string, string>
  refresh: () => Promise<boolean>
}

const localAuth: ServiceAuthPort = {
  isRemote: () => false,
  baseUrl: () => '',
  accessToken: () => '',
  headers: () => ({}),
  refresh: async () => false,
}

let activeAuth: ServiceAuthPort = localAuth

export function configureServiceAuth(port: ServiceAuthPort): void {
  activeAuth = port
}

export function serviceAuth(): ServiceAuthPort {
  return activeAuth
}
