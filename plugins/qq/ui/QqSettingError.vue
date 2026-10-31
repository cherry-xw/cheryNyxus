<script setup lang="ts">
import { computed } from 'vue'
import { qqSettingErrorId, type QQSettingsIssue } from './qqSettingsValidation'
const props=defineProps<{path:string;issues:QQSettingsIssue[]}>()
const messages=computed(()=>props.issues.filter(issue=>issue.path===props.path||issue.path.startsWith(props.path+'.')).map(issue=>issue.message))
</script>
<template><span v-if="messages.length" :id="qqSettingErrorId(path)" class="error">{{messages.join('；')}}</span></template>
