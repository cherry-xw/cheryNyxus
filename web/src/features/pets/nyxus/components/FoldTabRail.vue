<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue'
import { gsap } from 'gsap'
import { useNyxusHost } from '../application/host'
import type { ExecutionFoldMember } from '../graph/executionGraph'
import { foldTabForMember } from '../graph/foldTabs'
import { toolBatchDetail } from '../graph/toolBatchDetails'

const props = defineProps<{
  members: ExecutionFoldMember[]
  selectedMemberId?: string
  unreadCount?: number
  anchorX: number
  anchorY: number
  side?: 'left' | 'right'
}>()
const emit = defineEmits<{
  select: [memberId: string]
  interaction: [active: boolean]
  overflow: [hidden: number]
}>()
const { agents, theme: themeStore } = useNyxusHost()
const root = ref<HTMLElement | null>(null)
const pinned = ref(false)
const expanded = ref(false)
const orbitPhase = ref(0)
let context: gsap.Context | undefined
let orbitTween: gsap.core.Tween | undefined
let wiggleTween: gsap.core.Tween | undefined
let selectionTween: gsap.core.Tween | undefined
let pluginPromise: Promise<void> | undefined
let wheelAccumulator = 0
let stepActive = false
const queuedSteps: number[] = []

const RINGS = [
  { capacity: 6, radius: 66 },
  { capacity: 8, radius: 104 },
  { capacity: 10, radius: 142 },
] as const
const WHEEL_THRESHOLD = 34
const capacity = RINGS.reduce((sum, ring) => sum + ring.capacity, 0)

function displayTab(member: ExecutionFoldMember) {
  const tab = foldTabForMember(member, themeStore.theme)
  const call = toolBatchDetail(member.displayNode)?.calls[0]
  if (!call) return tab
  const meta = agents.senseTools.find((tool) => tool.name === call.name)
  return { ...tab, glyph: meta?.icon || tab.glyph, label: meta?.label?.trim() || call.name }
}

const visibleMembers = computed(() => {
  const visible = props.members.slice(0, capacity)
  const selected = props.members.find((member) => member.id === props.selectedMemberId)
  if (selected && !visible.some((member) => member.id === selected.id)) visible[capacity - 1] = selected
  return visible
})
const overflow = computed(() => Math.max(0, props.members.length - capacity))

function seamPoint(angle: number, radius: number): { left: number; top: number } {
  return {
    left: 156 + Math.cos(angle) * radius - 21,
    top: 166 + Math.sin(angle) * radius - 14,
  }
}

const satellites = computed(() => {
  let cursor = 0
  return RINGS.flatMap((ring, ringIndex) => {
    const group = visibleMembers.value.slice(cursor, cursor + ring.capacity)
    cursor += ring.capacity
    return group.map((member, slot) => {
      const angle =
        -Math.PI / 2 +
        (slot / Math.max(1, group.length)) * Math.PI * 2 +
        ringIndex * 0.18 +
        orbitPhase.value * (ringIndex % 2 ? -1 : 1)
      const point = seamPoint(angle, ring.radius)
      return {
        member,
        tab: displayTab(member),
        ring: ringIndex,
        style: {
          left: `${point.left}px`,
          top: `${point.top}px`,
          '--sat-delay': `${ringIndex * 0.04 + slot * 0.018}s`,
        } as CSSProperties,
      }
    })
  })
})
const navigationStyle = computed<CSSProperties>(() => ({
  left: `${props.side === 'right' ? props.anchorX + 18 : props.anchorX - 330}px`,
  top: `${props.anchorY - 166}px`,
}))

async function loadWiggle(): Promise<void> {
  pluginPromise ??= Promise.all([import('gsap/CustomEase'), import('gsap/CustomWiggle')]).then(
    ([easeModule, wiggleModule]) => {
      gsap.registerPlugin(easeModule.CustomEase, wiggleModule.CustomWiggle)
      wiggleModule.CustomWiggle.create('nyxus-orbit-wiggle', { wiggles: 7, type: 'random' })
    },
  )
  return pluginPromise
}

function setExpanded(value: boolean): void {
  expanded.value = value || pinned.value
  emit('interaction', expanded.value)
  if (!expanded.value || !root.value || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  void loadWiggle().then(() => {
    const nodes = root.value?.querySelectorAll('.orbit-satellite')
    if (nodes?.length) {
      wiggleTween?.kill()
      wiggleTween = gsap.fromTo(
        nodes,
        { x: 0 },
        { x: 2, duration: 0.34, stagger: 0.012, ease: 'nyxus-orbit-wiggle', clearProps: 'transform' },
      )
    }
  })
}

function togglePinned(): void {
  pinned.value = !pinned.value
  setExpanded(pinned.value)
}

function select(memberId: string): void {
  pinned.value = true
  expanded.value = true
  emit('interaction', true)
  emit('select', memberId)
}

function flushStep(): void {
  const direction = queuedSteps.shift()
  if (!direction || props.members.length === 0) {
    stepActive = false
    return
  }
  stepActive = true
  const current = Math.max(0, props.members.findIndex((member) => member.id === props.selectedMemberId))
  const next = props.members[(current + direction + props.members.length) % props.members.length]
  orbitTween?.kill()
  orbitTween = gsap.to(orbitPhase, {
    value: orbitPhase.value + direction * 0.28,
    duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.34,
    ease: 'power3.out',
    onComplete: () => {
      if (next) select(next.id)
      stepActive = false
      flushStep()
    },
  })
}

function enqueueStep(direction: number): void {
  queuedSteps.push(direction)
  if (!stepActive) flushStep()
}

function onWheel(event: WheelEvent): void {
  wheelAccumulator += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
  if (Math.abs(wheelAccumulator) < WHEEL_THRESHOLD) return
  event.preventDefault()
  const direction = wheelAccumulator > 0 ? 1 : -1
  wheelAccumulator = 0
  enqueueStep(direction)
}

function onKeydown(event: KeyboardEvent): void {
  const direction = ['ArrowRight', 'ArrowDown', 'PageDown'].includes(event.key)
    ? 1
    : ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)
      ? -1
      : 0
  if (!direction && event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  if (event.key === 'Escape') {
    pinned.value = false
    setExpanded(false)
  } else if (event.key === 'Enter' || event.key === ' ') {
    togglePinned()
  } else {
    enqueueStep(direction)
  }
}

function showOverflow(): void {
  pinned.value = true
  setExpanded(true)
  emit('overflow', overflow.value)
}

onMounted(() => {
  if (!root.value) return
  const media = gsap.matchMedia()
  context = gsap.context(() => {
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.to('.orbit-ring-visual', {
        rotation: (index) => (index % 2 ? -360 : 360),
        duration: (index) => 22 + index * 8,
        ease: 'none',
        repeat: -1,
        transformOrigin: '50% 50%',
      })
      gsap.to('.orbit-core-scan', { xPercent: 220, duration: 1.8, ease: 'none', repeat: -1 })
    })
  }, root.value)
  context.add(() => media.revert())
})

watch(
  () => props.selectedMemberId,
  () => {
    if (!root.value || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const selected = root.value.querySelector('.is-selected')
    if (selected) {
      selectionTween?.kill()
      selectionTween = gsap.fromTo(
        selected,
        { scale: 0.78, filter: 'brightness(2)' },
        { scale: 1, filter: 'brightness(1)', duration: 0.42, ease: 'back.out(2.4)', clearProps: 'transform,filter' },
      )
    }
  },
)

onBeforeUnmount(() => context?.revert())
onBeforeUnmount(() => {
  orbitTween?.kill()
  wiggleTween?.kill()
  selectionTween?.kill()
  queuedSteps.length = 0
})
</script>

<template>
  <nav
    ref="root"
    class="fold-orbit-navigation"
    :class="{ 'is-expanded': expanded, 'is-pinned': pinned }"
    :style="navigationStyle"
    aria-label="折叠过程卫星轨道"
    tabindex="0"
    @pointerenter="setExpanded(true)"
    @pointerleave="setExpanded(false)"
    @focusin="setExpanded(true)"
    @focusout="setExpanded(false)"
    @wheel="onWheel"
    @keydown="onKeydown"
  >
    <button class="orbit-core" type="button" :aria-pressed="pinned" @click.stop="togglePinned">
      <span class="orbit-core-scan" aria-hidden="true" />
      <strong>FOLD</strong>
      <small aria-label="折叠密度"><i v-for="ring in Math.min(5, Math.ceil(members.length / 5))" :key="ring" /></small>
    </button>
    <span
      v-for="(ring, index) in RINGS"
      :key="ring.capacity"
      class="orbit-ring-visual"
      :class="`ring-${index}`"
      :style="{ width: `${ring.radius * 2}px`, height: `${ring.radius * 2}px` }"
      aria-hidden="true"
    />
    <button
      v-for="satellite in satellites"
      :key="satellite.member.id"
      type="button"
      class="orbit-satellite"
      :class="[`ring-${satellite.ring}`, { 'is-selected': satellite.member.id === selectedMemberId }]"
      :style="satellite.style"
      :aria-current="satellite.member.id === selectedMemberId ? 'page' : undefined"
      :title="`${satellite.tab.label} · ${satellite.tab.status}`"
      @click.stop="select(satellite.member.id)"
    >
      <span :style="{ color: satellite.tab.accent }">{{ satellite.tab.glyph }}</span>
      <b>{{ satellite.tab.label }}</b>
      <i :style="{ background: satellite.tab.accent }" />
    </button>
    <button v-if="overflow" class="orbit-overflow" type="button" @click.stop="showOverflow">
      <span>INSPECTOR</span><b>OVERFLOW</b>
    </button>
    <span v-if="unreadCount" class="orbit-unread">NEW SIGNAL</span>
  </nav>
</template>

<style scoped lang="less">
.fold-orbit-navigation { position:absolute; z-index:3; width:312px; height:332px; outline:none; pointer-events:none; user-select:none; }
.orbit-core { position:absolute; z-index:8; left:132px; top:142px; width:48px; height:48px; overflow:hidden; border:1px solid var(--accent); clip-path:polygon(22% 0,78% 0,100% 22%,100% 78%,78% 100%,22% 100%,0 78%,0 22%); background:color-mix(in srgb,var(--nx-bg) 88%,var(--accent) 12%); color:var(--accent); box-shadow:0 0 18px var(--accent-glow),inset 0 0 16px var(--accent-soft); font-family:var(--font-mono); pointer-events:auto; cursor:pointer; }
.orbit-core strong,.orbit-core small { display:block; position:relative; z-index:1; }
.orbit-core strong { font-size:9px; letter-spacing:.12em; }
.orbit-core small { display:flex; justify-content:center; gap:2px; margin-top:5px; }
.orbit-core small i { width:3px; height:3px; background:currentcolor; box-shadow:0 0 4px currentcolor; }
.orbit-core-scan { position:absolute; inset:0 auto 0 -60%; width:45%; background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--accent) 55%,transparent),transparent); transform:skewX(-18deg); }
.orbit-ring-visual { position:absolute; left:156px; top:166px; translate:-50% -50%; border:1px solid color-mix(in srgb,var(--accent) 28%,transparent); border-radius:50%; background:repeating-conic-gradient(from 0deg,color-mix(in srgb,var(--accent) 44%,transparent) 0 1deg,transparent 1deg 14deg); mask:radial-gradient(transparent calc(50% - 2px),#000 calc(50% - 1px) 50%,transparent calc(50% + 1px)); opacity:.38; pointer-events:none; }
.orbit-satellite { position:absolute; z-index:6; width:42px; height:28px; display:grid; grid-template-columns:16px 1fr 3px; align-items:center; gap:3px; padding:3px 4px; border:1px solid color-mix(in srgb,var(--accent) 32%,var(--nx-border)); border-radius:0; background:color-mix(in srgb,var(--nx-bg) 92%,transparent); color:var(--nx-text); opacity:.18; scale:.72; pointer-events:none; transition:left 340ms cubic-bezier(.2,.8,.2,1),top 340ms cubic-bezier(.2,.8,.2,1),opacity .24s ease,scale .38s cubic-bezier(.2,.8,.2,1),filter .18s ease; transition-delay:var(--sat-delay); cursor:pointer; }
.is-expanded .orbit-satellite,.is-pinned .orbit-satellite { opacity:1; scale:1; pointer-events:auto; }
.orbit-satellite:hover { z-index:9; scale:1.18; filter:drop-shadow(0 0 8px var(--accent-glow)); }
.orbit-satellite.is-selected { border-color:var(--accent); background:color-mix(in srgb,var(--nx-bg) 78%,var(--accent) 22%); box-shadow:0 0 12px var(--accent-glow); }
.orbit-satellite span { font:700 10px/1 var(--font-mono); }
.orbit-satellite b { overflow:hidden; color:var(--nx-text); text-overflow:ellipsis; white-space:nowrap; font:600 7px/1 var(--font-mono); }
.orbit-satellite i { width:3px; height:12px; }
.orbit-overflow,.orbit-unread { position:absolute; z-index:10; right:0; bottom:5px; font:700 8px/1 var(--font-mono); letter-spacing:.08em; }
.orbit-overflow { display:flex; gap:7px; padding:6px 8px; border:1px solid var(--warning); background:var(--nx-bg); color:var(--warning); pointer-events:auto; cursor:pointer; }
.orbit-unread { top:8px; right:8px; bottom:auto; color:var(--warning); text-shadow:0 0 8px currentcolor; }
.fold-orbit-navigation:focus-visible .orbit-core { outline:2px solid var(--accent); outline-offset:3px; }
@media (prefers-reduced-motion: reduce) { .orbit-satellite { transition:none; } }
</style>
