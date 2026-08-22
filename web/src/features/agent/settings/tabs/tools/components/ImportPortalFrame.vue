<script setup lang="ts">
import { computed } from 'vue'
import { Close } from '@element-plus/icons-vue'

export type PortalPhase = 'source' | 'configure' | 'scanning' | 'review' | 'committing' | 'success'

const props = withDefaults(
  defineProps<{
    visible: boolean
    title: string
    eyebrow: string
    phase: PortalPhase
    statusText: string
    statusDetail?: string
    tone?: 'skill' | 'plugin'
    closable?: boolean
  }>(),
  { statusDetail: '', tone: 'skill', closable: true },
)

const emit = defineEmits<{ (e: 'close'): void }>()

const steps = [
  { key: 'source', label: '选包' },
  { key: 'configure', label: '拆封' },
  { key: 'review', label: '翻卡' },
  { key: 'success', label: '入库' },
] as const

const phaseIndex = computed(() => {
  if (props.phase === 'scanning') return 1
  if (props.phase === 'committing') return 2
  return Math.max(
    0,
    steps.findIndex((step) => step.key === props.phase),
  )
})
const opening = computed(() => props.phase === 'scanning' || props.phase === 'committing')
</script>

<template>
  <el-dialog
    :model-value="visible"
    append-to-body
    align-center
    destroy-on-close
    :show-close="false"
    width="min(780px, 94vw)"
    class="import-pack-dialog"
    @update:model-value="
      (open: boolean) => {
        if (!open && closable) emit('close')
      }
    "
  >
    <div class="pack-shell" :class="[`tone-${tone}`, `phase-${phase}`, { opening }]">
      <i class="club-light light-a" />
      <i class="club-light light-b" />
      <i class="club-light light-c" />

      <header class="pack-head">
        <div>
          <span class="pack-eyebrow">{{ eyebrow }}</span>
          <h3>{{ title }}</h3>
        </div>
        <button
          v-if="closable"
          type="button"
          class="pack-close"
          aria-label="关闭导入"
          @click="emit('close')"
        >
          <Close />
        </button>
      </header>

      <div class="pack-track" aria-label="导入进度">
        <template v-for="(step, index) in steps" :key="step.key">
          <span
            class="track-node"
            :class="{ active: index === phaseIndex, done: index < phaseIndex }"
          >
            <i>{{ index < phaseIndex ? '✓' : index + 1 }}</i
            ><b>{{ step.label }}</b>
          </span>
          <span
            v-if="index < steps.length - 1"
            class="track-line"
            :class="{ done: index < phaseIndex }"
          />
        </template>
      </div>

      <div class="pack-layout">
        <aside class="pack-showcase" aria-hidden="true">
          <span v-for="n in 10" :key="n" class="neon-confetti" :style="{ '--i': n }" />
          <div class="card-stack">
            <span class="preview-card card-left"><i /></span>
            <span class="preview-card card-mid"><i /></span>
            <span class="preview-card card-right"><i /></span>
          </div>
          <div class="foil-pack">
            <div class="foil-crimp crimp-top" />
            <div class="foil-face">
              <span class="pack-brand">CHERY DROP</span>
              <b>{{ tone === 'plugin' ? 'PLUGIN' : 'SKILL' }}</b>
              <strong>{{ phase === 'success' ? 'OPENED!' : 'BOOSTER' }}</strong>
              <small>NEON COLLECTION · 01</small>
            </div>
            <div class="tear-strip"><span>PEEL TO OPEN</span></div>
            <div class="foil-crimp crimp-bottom" />
          </div>
          <div class="pack-spark"><span v-for="n in 16" :key="n" :style="{ '--i': n }" /></div>
          <div class="showcase-copy">
            <b>{{ statusText }}</b>
            <small>{{ statusDetail }}</small>
          </div>
        </aside>

        <main class="pack-stage">
          <slot />
        </main>
      </div>

      <footer v-if="$slots.footer" class="pack-footer">
        <slot name="footer" />
      </footer>
    </div>
  </el-dialog>
</template>

<style lang="less">
.import-pack-dialog {
  padding: 0 !important;
  overflow: hidden;
  border: 1px solid rgba(46, 242, 255, 0.26);
  border-radius: 20px !important;
  background: #080b16 !important;
  box-shadow:
    0 32px 90px rgba(0, 0, 0, 0.58),
    0 0 0 1px rgba(255, 60, 172, 0.08) inset !important;
  .el-dialog__header,
  .el-dialog__footer {
    display: none;
  }
  .el-dialog__body {
    padding: 0 !important;
  }
}
.pack-shell {
  --pack: #2ef2ff;
  --pack-rgb: 46, 242, 255;
  --hot: #ff3cac;
  --lime: #c9ff43;
  --orange: #ff8a00;
  position: relative;
  min-height: 490px;
  padding: 18px;
  overflow: hidden;
  color: #f7f8ff;
  background:
    linear-gradient(112deg, rgba(46, 242, 255, 0.06), transparent 28%),
    linear-gradient(248deg, rgba(255, 60, 172, 0.08), transparent 34%),
    radial-gradient(circle at 76% 90%, rgba(201, 255, 67, 0.07), transparent 26%), #090d1a;
  animation: chroma-floor 4.8s steps(1, end) infinite;
  &.tone-plugin {
    --pack: #ff9d22;
    --pack-rgb: 255, 157, 34;
  }
  &::before {
    content: '';
    position: absolute;
    inset: -8px;
    pointer-events: none;
    opacity: 0.16;
    background:
      repeating-linear-gradient(
        105deg,
        transparent 0 17px,
        rgba(255, 255, 255, 0.11) 18px,
        transparent 19px 36px
      ),
      linear-gradient(90deg, rgba(46, 242, 255, 0.2), transparent 22% 72%, rgba(255, 36, 91, 0.2));
    mix-blend-mode: screen;
    animation: chroma-slices 2.6s steps(1, end) infinite;
  }
  &::after {
    content: '';
    position: absolute;
    left: -8%;
    right: -8%;
    bottom: 64px;
    height: 1px;
    transform: rotate(-5deg);
    background: linear-gradient(
      90deg,
      transparent,
      var(--hot),
      var(--orange),
      var(--lime),
      transparent
    );
    box-shadow: 0 0 18px rgba(255, 60, 172, 0.45);
  }
}
.club-light {
  position: absolute;
  width: 45%;
  height: 160%;
  top: -52%;
  filter: blur(20px);
  opacity: 0.075;
  pointer-events: none;
  transform-origin: top;
  animation: light-jump 3.1s steps(1, end) infinite;
}
.light-a {
  left: -8%;
  background: linear-gradient(var(--hot), transparent);
  transform: rotate(-19deg);
}
.light-b {
  left: 34%;
  background: linear-gradient(var(--pack), transparent);
  transform: rotate(9deg);
  animation-delay: -1.3s;
}
.light-c {
  right: -14%;
  background: linear-gradient(var(--lime), transparent);
  transform: rotate(26deg);
  animation-delay: -2.1s;
}
.pack-head {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.pack-eyebrow {
  display: block;
  margin-bottom: 4px;
  font:
    900 9px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.2em;
  color: var(--lime);
  text-shadow: 0 0 10px rgba(201, 255, 67, 0.48);
}
.pack-head h3 {
  margin: 0;
  font-size: 20px;
  letter-spacing: 0.02em;
  color: #fff;
}
.pack-close {
  width: 31px;
  height: 31px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 50%;
  background: #121727;
  color: #b9c0d4;
  cursor: pointer;
  transition: 0.18s ease;
}
.pack-close:hover {
  transform: rotate(9deg) scale(1.06);
  border-color: var(--hot);
  color: #fff;
  box-shadow: 0 0 16px rgba(255, 60, 172, 0.28);
}
.pack-close svg {
  width: 13px;
}
.pack-track {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  margin: 14px 2px 16px;
}
.track-node {
  display: flex;
  align-items: center;
  gap: 5px;
  color: #646d84;
  font-size: 9px;
  font-weight: 600;
  white-space: nowrap;
  transition: 0.22s ease;
}
.track-node i {
  width: 19px;
  height: 19px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 6px 3px 6px 3px;
  font:
    900 9px/1 ui-monospace,
    monospace;
  background: #111625;
  transform: rotate(-3deg);
}
.track-node.active,
.track-node.done {
  color: #e8ebf5;
}
.track-node.active i {
  color: #090d16;
  background: var(--lime);
  border-color: var(--lime);
  box-shadow: 0 0 15px rgba(201, 255, 67, 0.52);
  transform: rotate(4deg) scale(1.06);
}
.track-node.done i {
  color: var(--pack);
  border-color: rgba(var(--pack-rgb), 0.55);
}
.track-line {
  flex: 1;
  height: 2px;
  margin: 0 7px;
  background: rgba(148, 163, 184, 0.13);
  transform: skewX(-20deg);
}
.track-line.done {
  background: linear-gradient(90deg, var(--pack), var(--hot), var(--orange));
  box-shadow: 0 0 8px rgba(var(--pack-rgb), 0.28);
}
.pack-layout {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: 226px minmax(0, 1fr);
  gap: 14px;
  min-height: 352px;
}
.pack-showcase {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 18px;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.014));
  box-shadow: inset 0 0 45px rgba(var(--pack-rgb), 0.045);
}
.pack-showcase::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 72%;
  height: 34%;
  background: linear-gradient(
    90deg,
    rgba(255, 60, 172, 0.16),
    rgba(46, 242, 255, 0.12),
    rgba(201, 255, 67, 0.13)
  );
  filter: blur(20px);
  transform: skewY(-8deg);
}
.foil-pack {
  position: relative;
  z-index: 3;
  width: 126px;
  height: 184px;
  filter: drop-shadow(0 18px 20px rgba(0, 0, 0, 0.42));
  transform: rotate(-3deg);
  animation: pack-idle 3.2s ease-in-out infinite;
}
.foil-face {
  position: absolute;
  inset: 9px 4%;
  overflow: hidden;
  background: linear-gradient(
    145deg,
    #ff8a00 0 12%,
    #ff3cac 12% 27%,
    #17213b 27% 70%,
    #2ef2ff 70% 84%,
    #c9ff43 84%
  );
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.22);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.foil-face::before {
  content: '';
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(255, 255, 255, 0.48);
}
.foil-face::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    110deg,
    transparent 22%,
    rgba(255, 255, 255, 0.44) 38%,
    transparent 51%
  );
  transform: translateX(-110%);
  animation: foil-glint 2.8s ease-in-out infinite;
}
.pack-brand {
  position: relative;
  z-index: 1;
  margin-bottom: 13px;
  font:
    900 7px/1 ui-monospace,
    monospace;
  letter-spacing: 0.2em;
  color: #0b1020;
  background: var(--lime);
  padding: 4px 6px;
  transform: rotate(-2deg);
}
.foil-face b {
  position: relative;
  z-index: 1;
  font:
    1000 22px/0.86 system-ui,
    sans-serif;
  letter-spacing: -0.04em;
  color: #fff;
  text-shadow:
    2px 2px 0 #ff3cac,
    -2px -1px 0 #167d91;
}
.foil-face strong {
  position: relative;
  z-index: 1;
  margin-top: 5px;
  font:
    1000 12px/1 system-ui,
    sans-serif;
  font-style: italic;
  color: #0a1020;
  background: #fff;
  padding: 3px 8px;
  transform: skewX(-9deg);
}
.foil-face small {
  position: relative;
  z-index: 1;
  margin-top: 15px;
  font:
    800 6px/1 ui-monospace,
    monospace;
  letter-spacing: 0.12em;
  color: #fff;
}
.foil-crimp {
  position: absolute;
  z-index: 5;
  left: 4%;
  right: 4%;
  height: 15px;
  background: linear-gradient(180deg, #ff8a00 0%, #ff3cac 60%, #c92a78 100%);
  filter: blur(0.5px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -2px 3px rgba(0, 0, 0, 0.18);
  clip-path: polygon(
    0 32%,
    4% 3%,
    8% 35%,
    12% 0,
    16% 34%,
    20% 4%,
    24% 36%,
    28% 0,
    32% 34%,
    36% 3%,
    40% 35%,
    44% 0,
    48% 34%,
    52% 2%,
    56% 35%,
    60% 0,
    64% 34%,
    68% 3%,
    72% 36%,
    76% 0,
    80% 34%,
    84% 3%,
    88% 35%,
    92% 0,
    96% 34%,
    100% 3%,
    100% 100%,
    0 100%
  );
}
.crimp-top {
  top: 0;
}
.crimp-bottom {
  bottom: 0;
  left: 4%;
  right: 4%;
  transform: rotate(180deg);
  background: linear-gradient(180deg, #c9ff43 0%, #2ef2ff 55%, #5fa878 100%);
}
.tear-strip {
  position: absolute;
  z-index: 7;
  left: 4%;
  right: 4%;
  top: 25px;
  height: 17px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(90deg, #c9ff43, #2ef2ff, #ff3cac, #ff8a00);
  color: #090d18;
  font:
    1000 6px/1 ui-monospace,
    monospace;
  letter-spacing: 0.12em;
  transform: rotate(-1deg);
  filter: drop-shadow(0 2px 0 rgba(0, 0, 0, 0.3));
}
.card-stack {
  position: absolute;
  z-index: 2;
  left: 50%;
  top: 42%;
  width: 150px;
  height: 170px;
  transform: translate(-50%, -50%);
}
.preview-card {
  position: absolute;
  left: 43px;
  top: 25px;
  width: 68px;
  height: 100px;
  border: 2px solid #eef6ff;
  border-radius: 8px;
  background: repeating-linear-gradient(135deg, #11182c 0 8px, #1d2945 8px 16px);
  box-shadow:
    0 0 0 2px #ff3cac,
    0 12px 20px rgba(0, 0, 0, 0.34);
  opacity: 0;
  transform-origin: 50% 115%;
}
.preview-card i {
  position: absolute;
  inset: 9px;
  border: 1px solid rgba(46, 242, 255, 0.56);
  border-radius: 5px;
  background: linear-gradient(135deg, rgba(255, 60, 172, 0.24), rgba(46, 242, 255, 0.16));
}
.phase-review .card-left,
.phase-committing .card-left,
.phase-success .card-left {
  opacity: 1;
  transform: translate(-40px, -5px) rotate(-18deg);
}
.phase-review .card-mid,
.phase-committing .card-mid,
.phase-success .card-mid {
  opacity: 1;
  transform: translate(0, -20px) rotate(1deg);
}
.phase-review .card-right,
.phase-committing .card-right,
.phase-success .card-right {
  opacity: 1;
  transform: translate(40px, -3px) rotate(19deg);
}
.phase-success .preview-card {
  animation: card-pop 0.66s cubic-bezier(0.18, 0.85, 0.24, 1.2) both;
}
.phase-success .foil-pack {
  opacity: 0.18;
  transform: translateY(66px) rotate(11deg) scale(0.72);
}
.opening .foil-pack {
  animation: pack-rattle 0.32s ease-in-out infinite;
}
.opening .tear-strip {
  animation: tear-open 1.05s cubic-bezier(0.2, 0.75, 0.2, 1) infinite;
}
.neon-confetti {
  --x: calc((var(--i) - 5) * 17px);
  position: absolute;
  left: 50%;
  top: 44%;
  width: 4px;
  height: 10px;
  border-radius: 2px;
  background: hsl(calc(var(--i) * 47), 100%, 62%);
  box-shadow: 0 0 8px currentColor;
  opacity: 0.42;
  transform: translate(var(--x), calc(var(--i) * 8px - 82px)) rotate(calc(var(--i) * 31deg));
}
.pack-spark {
  position: absolute;
  z-index: 8;
  left: 50%;
  top: 42%;
}
.pack-spark span {
  --angle: calc(var(--i) * 22.5deg);
  position: absolute;
  width: 5px;
  height: 3px;
  border-radius: 4px;
  background: hsl(calc(var(--i) * 31), 100%, 64%);
  box-shadow: 0 0 8px currentColor;
  opacity: 0;
}
.phase-success .pack-spark span {
  animation: pack-burst 0.8s ease-out both;
  animation-delay: calc(var(--i) * 15ms);
}
.showcase-copy {
  position: absolute;
  z-index: 9;
  left: 12px;
  right: 12px;
  bottom: 15px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.showcase-copy b {
  font-size: 12px;
  color: #fff;
}
.showcase-copy small {
  min-height: 27px;
  font-size: 9px;
  line-height: 1.45;
  color: #8e98ae;
}
.pack-stage {
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(255, 255, 255, 0.095);
  border-radius: 15px;
  background: rgba(14, 19, 34, 0.8);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(14px);
}
.pack-footer {
  position: relative;
  z-index: 3;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 14px;
}
@keyframes chroma-floor {
  0%,
  88%,
  100% {
    background-position:
      0 0,
      0 0,
      0 0,
      0 0;
    box-shadow:
      inset 9px 0 0 rgba(46, 242, 255, 0.015),
      inset -9px 0 0 rgba(255, 36, 91, 0.015);
  }
  89% {
    background-position:
      -8px 2px,
      7px -2px,
      0 0,
      0 0;
    box-shadow:
      inset 15px 0 0 rgba(46, 242, 255, 0.05),
      inset -13px 0 0 rgba(255, 36, 91, 0.045);
  }
  91% {
    background-position:
      6px -1px,
      -5px 2px,
      0 0,
      0 0;
  }
  93% {
    background-position:
      -3px 1px,
      4px -1px,
      0 0,
      0 0;
  }
}
@keyframes chroma-slices {
  0%,
  82%,
  100% {
    transform: translate(0);
    clip-path: inset(0);
  }
  83% {
    transform: translate(-9px, 2px);
    clip-path: polygon(0 7%, 100% 7%, 100% 21%, 0 21%, 0 64%, 100% 64%, 100% 76%, 0 76%);
  }
  85% {
    transform: translate(8px, -1px);
    clip-path: polygon(0 29%, 100% 29%, 100% 42%, 0 42%, 0 83%, 100% 83%, 100% 91%, 0 91%);
  }
  87% {
    transform: translate(-4px);
    clip-path: inset(0);
  }
}
@keyframes light-jump {
  0%,
  84%,
  100% {
    translate: 0 0;
    opacity: 0.075;
  }
  85% {
    translate: 12px -3px;
    opacity: 0.12;
  }
  87% {
    translate: -8px 2px;
    opacity: 0.055;
  }
  89% {
    translate: 4px 0;
    opacity: 0.1;
  }
}
@keyframes pack-idle {
  50% {
    transform: translateY(-5px) rotate(1deg);
  }
}
@keyframes foil-glint {
  0%,
  35% {
    transform: translateX(-115%);
  }
  70%,
  100% {
    transform: translateX(120%);
  }
}
@keyframes pack-rattle {
  0%,
  100% {
    transform: rotate(-4deg) translateX(-2px);
  }
  50% {
    transform: rotate(3deg) translateX(2px);
  }
}
@keyframes tear-open {
  /* 完整贴合，仅轻微施力抖动 */
  0% {
    transform: translateX(0) translateY(0) rotate(-1deg);
    opacity: 1;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  15% {
    transform: translateX(2px) translateY(-1px) rotate(0deg);
    opacity: 1;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
  }
  /* 左侧撕开，锯齿边推到 ~30%，右侧仍粘连 */
  40% {
    transform: translateX(6px) translateY(-2px) rotate(2deg);
    opacity: 1;
    clip-path: polygon(28% 0, 33% 30%, 27% 60%, 32% 100%, 100% 100%, 100% 0);
  }
  /* 撕到中段，右侧多半仍在 */
  65% {
    transform: translateX(12px) translateY(-4px) rotate(4deg);
    opacity: 0.95;
    clip-path: polygon(58% 0, 63% 30%, 56% 60%, 62% 100%, 100% 100%, 100% 0);
  }
  /* 仅右端一截残留，粘连到最后 */
  88% {
    transform: translateX(20px) translateY(-6px) rotate(6deg);
    opacity: 0.5;
    clip-path: polygon(82% 0, 87% 35%, 80% 65%, 86% 100%, 100% 100%, 100% 0);
  }
  /* 完全撕离 */
  100% {
    transform: translateX(28px) translateY(-8px) rotate(8deg);
    opacity: 0;
    clip-path: polygon(100% 0, 100% 100%);
  }
}
@keyframes card-pop {
  0% {
    opacity: 0;
    transform: translateY(45px) scale(0.65);
  }
  100% {
    opacity: 1;
  }
}
@keyframes pack-burst {
  0% {
    opacity: 1;
    transform: rotate(var(--angle)) translateX(4px);
  }
  100% {
    opacity: 0;
    transform: rotate(var(--angle)) translateX(105px) scale(0.2);
  }
}
@media (max-width: 680px) {
  .pack-shell {
    padding: 14px;
  }
  .pack-layout {
    grid-template-columns: 1fr;
  }
  .pack-showcase {
    min-height: 174px;
  }
  .foil-pack {
    transform: scale(0.72) rotate(-3deg);
  }
  .showcase-copy {
    left: auto;
    width: 45%;
    top: 50%;
    bottom: auto;
    transform: translateY(-50%);
  }
  .card-stack {
    left: 26%;
  }
  .pack-stage {
    min-height: 260px;
  }
  .pack-track b {
    display: none;
  }
}
</style>

<style lang="less">
.pack-select-popper.el-popper {
  border: 1px solid rgba(46, 242, 255, 0.22) !important;
  border-radius: 11px !important;
  background: #0c1120 !important;
  box-shadow:
    0 16px 34px rgba(0, 0, 0, 0.52),
    4px 4px 0 rgba(255, 60, 172, 0.08) !important;
  .el-popper__arrow::before {
    border-color: rgba(46, 242, 255, 0.22) !important;
    background: #0c1120 !important;
  }
  .el-select-dropdown__item {
    height: 30px;
    line-height: 30px;
    color: #a4aec1;
    font-size: 10px;
    border-radius: 7px;
    margin: 2px 5px;
    padding: 0 9px;
  }
  .el-select-dropdown__item.is-hovering {
    background: rgba(46, 242, 255, 0.09);
    color: #d8fcff;
  }
  .el-select-dropdown__item.is-selected {
    background: linear-gradient(
      90deg,
      rgba(46, 242, 255, 0.2),
      rgba(255, 60, 172, 0.15),
      rgba(255, 138, 0, 0.12)
    );
    color: #c9ff43;
    font-weight: 600;
    text-shadow: 0 0 8px rgba(201, 255, 67, 0.28);
  }
  .el-select-dropdown__empty {
    color: #68738a;
    font-size: 10px;
  }
}
</style>
