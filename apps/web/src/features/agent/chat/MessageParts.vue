<script setup lang="ts">
import type { MessagePart } from '@/application/files/public'
import AssetCard from './AssetCard.vue'
import MessageTextPart from './MessageTextPart.vue'
defineProps<{ parts: MessagePart[]; chatId?: string; markdown?: boolean }>()
</script>
<template>
  <div class="message-parts">
    <template v-for="part in parts" :key="part.partId">
      <AssetCard v-if="part.type === 'asset'" :part="part" :chat-id="chatId" />
      <MessageTextPart v-else-if="part.type === 'text'" :text="part.text" :markdown="markdown" />
      <span v-else-if="part.type === 'directive'" class="instruction-message-token">{{ part.command }} {{ part.args }}</span>
      <span v-else-if="part.type === 'role_mention'" class="instruction-message-token">@{{ part.roleName }}</span>
      <span v-else-if="part.type === 'workspace_ref'" class="instruction-message-token">&amp;{{ part.path }}</span>
    </template>
  </div>
</template>
