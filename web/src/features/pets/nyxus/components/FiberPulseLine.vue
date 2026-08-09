<script setup lang="ts">
/**
 * Uniform execution-edge renderer.
 *
 * Every relation uses the same solid base and native SVG travelling light.
 * The path direction is the propagation direction, so the effect works for
 * vertical, diagonal, and upward curves without geometry-specific branches.
 */
import { computed } from 'vue'
import {
  EXECUTION_EDGE_PULSE_INTERVAL,
  EXECUTION_EDGE_PULSE_SEGMENTS,
  edgePulseDashPattern,
} from '../graph/edgeMotion'

interface Props {
  d: string
  /** Optional light path; the solid base always follows d. */
  pulseD?: string
  color: string
  pulseColor?: string
  /** Stable phase offset in seconds. */
  delay?: number
  active?: boolean
}

const props = defineProps<Props>()

const begin = computed(() => `${-(props.delay ?? 0)}s`)
const lightPath = computed(() => props.pulseD ?? props.d)
const lightColor = computed(() => props.pulseColor ?? props.color)
const pulseSegments = EXECUTION_EDGE_PULSE_SEGMENTS
const duration = `${EXECUTION_EDGE_PULSE_INTERVAL}s`

function dashArray(segmentLength: number): string {
  const pattern = edgePulseDashPattern(segmentLength)
  return `${pattern.dash} ${pattern.gap}`
}

function dashValues(segmentLength: number): string {
  const pattern = edgePulseDashPattern(segmentLength)
  return `${pattern.from};${pattern.to}`
}
</script>

<template>
  <g class="fiber" :class="{ 'is-active': active }">
    <!-- Every relation keeps the same solid topology line; relation color is resolved upstream. -->
    <path class="fiber-bus" :d="d" :stroke="color" />
    <path class="fiber-core" :d="d" :stroke="color" />

    <!-- Fixed-interval repeated layers: a bright 72px head followed by a 48px fading tail. -->
    <path
      v-for="segment in pulseSegments"
      :key="segment.name"
      :class="['fiber-light', `fiber-light-${segment.name}`]"
      :d="lightPath"
      :stroke="lightColor"
      :stroke-dasharray="dashArray(segment.length)"
    >
      <animate
        attributeName="stroke-dashoffset"
        :dur="duration"
        :begin="begin"
        :values="dashValues(segment.length)"
        calcMode="linear"
        repeatCount="indefinite"
      />
    </path>
  </g>
</template>

<style scoped lang="less">
.fiber-bus,
.fiber-core,
.fiber-light {
  fill: none;
  stroke-linecap: round;
}
/* Topology is always solid. Edge kinds differ only through their stroke color. */
.fiber-bus {
  stroke-width: 4.5;
  opacity: 0.07;
}
.fiber-core {
  stroke-width: 1.35;
  opacity: 0.38;
}
.fiber.is-active .fiber-core {
  opacity: 0.52;
}

/* Equal widths prevent the pulse from reading as a thickened connection. */
.fiber-light {
  stroke-width: 2.2;
  opacity: calc(var(--segment-opacity) * var(--pulse-brightness, 1));
}
.fiber-light-tail-far {
  --segment-opacity: 0.12;
}
.fiber-light-tail-mid {
  --segment-opacity: 0.16;
}
.fiber-light-tail-near {
  --segment-opacity: 0.22;
}
.fiber-light-tail-base {
  --segment-opacity: 0.3;
}
.fiber-light-head {
  --segment-opacity: 0.48;
}
.fiber-light-head-core {
  --segment-opacity: 0.3;
}
.fiber-light-head-tip {
  --segment-opacity: 0.55;
}
.fiber.is-active {
  --pulse-brightness: 1.12;
}

@media (prefers-reduced-motion: reduce) {
  .fiber-light {
    display: none;
  }
}
</style>
