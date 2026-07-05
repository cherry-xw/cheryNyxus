<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useConnectionStore } from '@/stores/connection'

interface Brain {
  name: string
  provider: string
  model: string
  thinking?: boolean
}

const conn = useConnectionStore()
const brains = ref<Brain[]>([])
const error = ref<string | null>(null)

onMounted(async () => {
  await conn.init()
  try {
    const res = await conn.rpc('brain.list', {})
    if (res.success && res.data) {
      brains.value = (res.data as { brains: Brain[] }).brains
    } else if (res.error) {
      error.value = res.error.message
    }
  } catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <el-card>
    <h1>cheryClaw</h1>
    <p>
      状态:
      <el-tag :type="conn.status === 'connected' ? 'success' : 'info'">
        {{ conn.status }}
      </el-tag>
    </p>
    <p v-if="error" style="color: red">{{ error }}</p>
    <h2>Brains</h2>
    <ul>
      <li v-for="b in brains" :key="b.name">
        {{ b.name }} — {{ b.provider }} / {{ b.model }}
      </li>
    </ul>
  </el-card>
</template>
