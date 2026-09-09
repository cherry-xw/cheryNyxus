import { readonly, ref } from 'vue'

const revision = ref(0)
export const archiveRevision = readonly(revision)
export function invalidateArchives(): void {
  revision.value += 1
}
