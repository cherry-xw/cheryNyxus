<script setup lang="ts">
import { ServerLoginDialog } from '@/features/auth/public'
import { desktopBridge } from './desktopBridge'

function close(): void {
  desktopBridge()?.windowControl('close')
}
</script>

<template>
  <ServerLoginDialog :visible="true" native @update:visible="close" />
</template>
