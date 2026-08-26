import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PetInstance } from '@/domain/pets/types'

/**
 * Pet presentation owner. Coordinates and animation state live here; chat facts do not.
 * Session-to-pet reconciliation is injected by the application runtime.
 */
export const usePetPresentationStore = defineStore('petPresentation', () => {
  const pets = ref<PetInstance[]>([])
  return { pets }
})
