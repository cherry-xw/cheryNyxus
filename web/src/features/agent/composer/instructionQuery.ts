/** Match only a trigger at the caret, excluding existing tokens and URL slashes. */
export function instructionQuery(text: string, caret: number) {
  const prefix = text.slice(0, caret)
  const match = /(?:^|\s)([/@&])([^\r\n\[\]@&]*)$/.exec(prefix)
  if (!match || (match[1] !== '&' && /\s|\//.test(match[2]!))) return null
  return { trigger: match[1]!, query: match[2]!, start: caret - match[2]!.length - 1, end: caret }
}
