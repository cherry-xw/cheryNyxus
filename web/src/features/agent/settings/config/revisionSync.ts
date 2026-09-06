export function externalRevisionAction(input: {
  revision?: string
  baseRevision: string
  dirty: boolean
  saving: boolean
}): 'ignore' | 'preserve' | 'reload' {
  if (!input.revision || !input.baseRevision || input.revision === input.baseRevision)
    return 'ignore'
  return input.dirty || input.saving ? 'preserve' : 'reload'
}

export function isRevisionConflict(message: string): boolean {
  return message.includes('baseRevision 已过期')
}
