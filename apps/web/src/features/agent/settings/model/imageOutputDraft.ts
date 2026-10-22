import {
  ImageOutputCapabilitySchema,
  isImageOutputOperation,
  type ImageOutputCapabilities,
  type ImageOutputCapability,
} from '@chery/protocol'

/** Returns a new draft; omitting the patch restores this operation's catalog settings. */
export function updateImageOutputDraft(
  current: ImageOutputCapabilities | undefined,
  operation: string,
  patch?: Partial<ImageOutputCapability>,
  inherited?: ImageOutputCapability,
): ImageOutputCapabilities | undefined {
  if (!isImageOutputOperation(operation)) return current
  const value = { ...current }
  if (patch) {
    value[operation] = {
      nativeMultiImage: 'unknown',
      countControl: 'unknown',
      ...inherited,
      ...value[operation],
      ...patch,
    }
  } else delete value[operation]
  return Object.keys(value).length ? value : undefined
}

export function imageOutputDraftErrors(
  current: ImageOutputCapabilities | undefined,
  operation: string,
): string {
  if (!isImageOutputOperation(operation) || !current?.[operation]) return ''
  const parsed = ImageOutputCapabilitySchema.safeParse(current[operation])
  return parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('；')
}
