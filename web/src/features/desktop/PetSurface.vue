<script setup lang="ts">
import { computed, watch } from 'vue'
import PetStage from '@/features/pets/PetStage.vue'
import { useAgentsStore } from '@/stores'
import { desktopBridge } from './desktopBridge'
import FloatingSurfaceRoot from './FloatingSurfaceRoot.vue'

const agents = useAgentsStore()
const visibleCount = computed(() => agents.pets.filter((pet) => !pet.isGhost).length)
const bridge = desktopBridge()
watch(visibleCount, (count) => bridge?.setSurfaceState({ visiblePetCount: count }), { immediate: true })
</script>

<template>
  <FloatingSurfaceRoot label="Desktop pets">
    <PetStage transparent floating-native />
  </FloatingSurfaceRoot>
</template>
