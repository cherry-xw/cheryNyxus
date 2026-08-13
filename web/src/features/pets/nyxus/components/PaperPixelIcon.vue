<script setup lang="ts">
import type { PaperPixelIconName } from '../paper/paperCardModel'

defineProps<{ name: PaperPixelIconName }>()
</script>

<template>
  <svg class="paper-pixel-icon" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true">
    <g v-if="name === 'adventurer'">
      <path d="M5 1h6v2h2v5h-2v2H5V8H3V3h2z" class="icon-light" />
      <path d="M4 10h8v2h2v4H2v-4h2zM5 5h2v2H5zm4 0h2v2H9z" />
    </g>
    <g v-else-if="name === 'magic'">
      <path d="M7 0h2v4h3v2h4v2h-4v2H9v6H7v-6H4V8H0V6h4V4h3z" />
      <path d="M7 5h2v4H7z" class="icon-light" />
    </g>
    <g v-else-if="name === 'companion'">
      <path d="M2 2h5v6H2zM9 1h5v6H9zM0 10h9v6H0zm8-1h8v7H8z" />
      <path d="M3 4h1v2H3zm8-1h1v2h-1z" class="icon-light" />
    </g>
    <g v-else-if="name === 'gear'">
      <path d="M6 0h4v2h2v2h2v2h2v4h-2v2h-2v2h-2v2H6v-2H4v-2H2v-2H0V6h2V4h2V2h2z" />
      <path d="M6 5h4v2h2v4h-2v2H6v-2H4V7h2zm1 2v4h2V7z" class="icon-light" />
    </g>
    <g v-else-if="name === 'chest'">
      <path d="M1 3h14v4h1v9H0V7h1zm3-2h8v2H4z" />
      <path d="M2 5h12v2H2zm6 4h3v4H8z" class="icon-light" />
    </g>
    <g v-else-if="name === 'scroll'">
      <path d="M3 0h11v2h2v4h-2v9H3v-2H1V2h2z" />
      <path d="M4 3h8v2H4zm0 4h7v2H4zm0 4h5v2H4zM1 1h4v3H1z" class="icon-light" />
    </g>
    <g v-else-if="name === 'seal'">
      <path d="M5 0h6v2h2v6h-2l2 8-5-3-5 3 2-8H3V2h2z" />
      <path d="M6 3h4v4H6z" class="icon-light" />
    </g>
    <g v-else-if="name === 'book'">
      <path d="M0 2h6l2 2 2-2h6v12h-6l-2 2-2-2H0z" />
      <path d="M2 4h4v7H2zm8 0h4v7h-4zM7 5h2v9H7z" class="icon-light" />
    </g>
    <g v-else-if="name === 'quill' || name === 'ink'">
      <path d="M12 0h4v4h-2v2h-2v2h-2v2H8v2H6v4H3v-3h1v-3h2V8h2V6h2V4h2z" />
      <path d="M9 5h3v2H9zM5 11h3v2H5z" class="icon-light" />
    </g>
    <g v-else-if="name === 'map'">
      <path d="M0 2l5-2 6 2 5-2v14l-5 2-6-2-5 2z" />
      <path d="M5 2h2v10H5zm5 2h2v10h-2z" class="icon-light" />
    </g>
    <g v-else-if="name === 'shield'">
      <path d="M1 1h14v8h-2v3h-2v2H9v2H7v-2H5v-2H3V9H1z" />
      <path d="M4 4h3v7H5V9H4zm5 0h3v5h-1v2H9z" class="icon-light" />
    </g>
    <g v-else-if="name === 'clock'">
      <path d="M5 0h6v2h3v3h2v6h-2v3h-3v2H5v-2H2v-3H0V5h2V2h3z" />
      <path d="M7 3h2v5h4v2H7z" class="icon-light" />
    </g>
    <g v-else-if="name === 'warning'">
      <path d="M7 0h2v2h2v4h2v4h2v6H1v-6h2V6h2V2h2z" />
      <path d="M7 5h2v6H7zm0 8h2v2H7z" class="icon-light" />
    </g>
    <g v-else>
      <path d="M7 0h2v5h5v2H9v2h5v2H9v5H7v-5H2V9h5V7H2V5h5z" />
      <path d="M7 5h2v6H7z" class="icon-light" />
    </g>
  </svg>
</template>

<style scoped lang="less">
.paper-pixel-icon {
  display: block;
  width: 1em;
  height: 1em;
  overflow: visible;
  fill: currentcolor;
  image-rendering: pixelated;
}
.icon-light {
  fill: color-mix(in srgb, currentcolor 38%, white);
}
</style>
