<script setup lang="ts">
import { ref } from "vue";
import PetSprite from "./PetSprite.vue";
import { usePetWorld } from "./usePetWorld";

const stageRef = ref<HTMLElement | null>(null);
const {
  pets,
  isPaused,
  activeCount,
  addPet,
  resetPets,
  randomEmotion,
  togglePause,
  startDrag,
  dragPet,
  endDrag,
  hoverPet,
  clickPet,
  invokeTool,
} = usePetWorld(stageRef);
</script>

<template>
  <main ref="stageRef" class="pet-stage" aria-label="Interactive desktop pets">
    <div class="toolbar" aria-label="Pet controls">
      <button type="button" @click="addPet">+ pet</button>
      <button type="button" @click="togglePause">{{ isPaused ? "play" : "pause" }}</button>
      <button type="button" @click="resetPets">reset</button>
      <button type="button" @click="randomEmotion">mood</button>
      <span>{{ activeCount }} active</span>
    </div>

    <PetSprite
      v-for="pet in pets"
      :key="pet.instanceId"
      :pet="pet"
      :paused="isPaused"
      @start-drag="startDrag"
      @drag="dragPet"
      @end-drag="endDrag"
      @hover="hoverPet"
      @click-pet="clickPet"
      @tool="(pet, id) => invokeTool(pet, id)"
    />
  </main>
</template>

<style scoped>
.pet-stage {
  position: fixed;
  inset: 0;
  overflow: hidden;
  min-width: 320px;
  min-height: 420px;
  background:
    linear-gradient(rgba(255, 255, 255, 0.36) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.36) 1px, transparent 1px),
    radial-gradient(circle at 18% 18%, rgba(255, 196, 87, 0.34), transparent 28%),
    radial-gradient(circle at 82% 28%, rgba(88, 196, 189, 0.28), transparent 30%),
    radial-gradient(circle at 50% 80%, rgba(151, 122, 255, 0.26), transparent 34%),
    #f5f0e8;
  background-size:
    42px 42px,
    42px 42px,
    auto,
    auto,
    auto,
    auto;
  color: #25262d;
}

.pet-stage::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.74), transparent 22%),
    linear-gradient(0deg, rgba(0, 0, 0, 0.08), transparent 34%);
}

.toolbar {
  position: absolute;
  z-index: 30;
  left: 16px;
  top: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  max-width: min(520px, calc(100vw - 32px));
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.68);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.68);
  box-shadow: 0 12px 30px rgba(47, 37, 28, 0.14);
  backdrop-filter: blur(14px);
}

.toolbar button {
  min-width: 54px;
  height: 32px;
  padding: 0 11px;
  border: 1px solid rgba(36, 38, 45, 0.14);
  border-radius: 7px;
  color: #24262d;
  background: rgba(255, 255, 255, 0.8);
  font: 700 13px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  cursor: pointer;
}

.toolbar button:hover {
  background: #ffffff;
  transform: translateY(-1px);
}

.toolbar button:active {
  transform: translateY(0);
}

.toolbar span {
  padding: 0 5px;
  color: rgba(36, 38, 45, 0.68);
  font-size: 13px;
  font-weight: 700;
}

@media (max-width: 520px) {
  .toolbar {
    left: 10px;
    top: 10px;
  }

  .toolbar button {
    min-width: 48px;
    padding: 0 8px;
  }
}
</style>
