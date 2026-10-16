export function backendComponentRoot(moduleUrl: string): string
export function initializeBackendEnvironment(moduleUrl: string, env?: NodeJS.ProcessEnv): {
  componentRoot: string
  runtimeRoot: string
  envFile: string
  templateDir: string
}
