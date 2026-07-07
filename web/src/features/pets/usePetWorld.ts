import { computed, onMounted, onUnmounted, reactive, ref, type Ref } from "vue";
import { generatePet } from "./petPresets";
import { PET_WIDTH, PET_HEIGHT, arrivedAtTarget, findSpawnPosition, keepInBounds, stepMovement } from "./petMovement";
import type { PetAction, PetInstance, PetMood, PetPreset, PetTool, StageBounds } from "./types";

const CHAT_DISTANCE = 126;
const TRIBE_CLUSTER_RADIUS = 70; // 子 pet retarget 偏向本主的半径
const CHAT_DURATION_MIN = 1500;
const CHAT_DURATION_MAX = 3000;
const CHAT_COOLDOWN = 6500;
const RAPID_CLICK_WINDOW = 1200;
const RAPID_CLICK_THRESHOLD = 3;
const PANIC_MOVEMENT = 32;

// --- 状态系统（养桌宠） ---
const EMOTION_INIT = 70;
const EMOTION_DECAY = 0.6; // 每秒缓降
const EMOTION_RECOVER = 4; // 休息时每秒上升
const FATIGUE_WALK_RATE = 1.2; // 移动每秒累积
const FATIGUE_CHAT = 8; // 每次聊天累积
const FATIGUE_SLEEP = 80; // 自动休息阈值
const FATIGUE_WAKE = 10; // 自然醒阈值
const FATIGUE_RECOVER = 12; // 休息时每秒下降
// emotion 交互增量
const EMOTE_CLICK = 6;
const EMOTE_RAPID = -8;
const EMOTE_DRAG = -3;
const EMOTE_HOVER = 1;
const EMOTE_DISTURB = -5;
const EMOTE_FEED = 15;
const EMOTE_PET = 8;
const EMOTE_PUNCH = -10;

// 主 pet 独立物理（更慢更稳）：比默认（petMovement）更低速度/加速度/斥力/半径
const MASTER_ACCELERATION = 50; // 默认 80 → 更缓启停
const MASTER_TRIBE_REPEL = 200; // 默认 300 → 同部落近距更不弹
const MASTER_OTHER_REPEL = 320; // 默认 450 → 异部落分离更柔
const MASTER_REPEL_RADIUS = 100; // 默认 120
const MASTER_ATTRACT_RADIUS = 180; // 默认 200

// 主 pet 工具：preset.tools 前置 summon（去重）。主 pet 才能召子入部落。
function masterTools(preset: PetPreset): PetTool[] {
  if (preset.tools.some((t) => t.id === "summon")) return preset.tools;
  return [{ id: "summon", icon: "➕", label: "召伙伴", core: true }, ...preset.tools];
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(items: readonly T[]): T {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) {
    throw new Error("Cannot pick from an empty list");
  }
  return item;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function distance(a: PetInstance, b: PetInstance): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function randomTarget(bounds: StageBounds): { x: number; y: number } {
  return {
    x: rand(16, Math.max(16, bounds.width - PET_WIDTH - 16)),
    y: rand(56, Math.max(56, bounds.height - PET_HEIGHT - 16)),
  };
}

function moodForAction(action: PetAction): PetMood {
  if (action === "dragging") return "surprised";
  if (action === "clicked") return "happy";
  if (action === "chatting") return pick(["happy", "nagging", "curious"] as const);
  if (action === "dropped") return "sad";
  if (action === "sleep") return "sleepy";
  return "calm";
}

function actionTalk(pet: PetInstance, action: PetAction): string {
  return pick(pet.behaviors?.[action]?.talks ?? pet.talks);
}

// 基础 mood：状态驱动（临时 mood 到期后回落）
function restMood(pet: PetInstance): PetMood {
  if (pet.action === "sleep" || pet.fatigue >= FATIGUE_SLEEP) return "sleepy";
  if (pet.emotion < 25) return "sad";
  if (pet.emotion < 50) return "calm";
  return pet.isMaster ? "serious" : "calm";
}

function adjustEmotion(pet: PetInstance, delta: number): void {
  pet.emotion = clamp(pet.emotion + delta, 0, 100);
}

function adjustFatigue(pet: PetInstance, delta: number): void {
  pet.fatigue = clamp(pet.fatigue + delta, 0, 100);
}

function createPet(
  preset: PetPreset,
  bounds: StageBounds,
  index: number,
  isMaster: boolean,
  masterId?: string,
): PetInstance {
  const now = performance.now();
  const instanceId = `${preset.id}-${now.toString(36)}-${index}`;
  const start = randomTarget(bounds);
  const target = randomTarget(bounds);

  return {
    ...preset,
    instanceId,
    isMaster,
    tribe: isMaster ? instanceId : (masterId ?? instanceId),
    tools: isMaster ? masterTools(preset) : preset.tools,
    x: start.x,
    y: start.y,
    vx: 0,
    vy: 0,
    targetX: target.x,
    targetY: target.y,
    width: PET_WIDTH,
    height: PET_HEIGHT,
    direction: 1,
    mood: isMaster ? "serious" : "calm",
    action: "walk",
    speech: "",
    speechUntil: 0,
    moodUntil: 0,
    interactionUntil: 0,
    lastInteractionAt: now,
    emotion: EMOTION_INIT,
    fatigue: 0,
    dragOffsetX: 0,
    dragOffsetY: 0,
    draggingPointerId: null,
    pairCooldowns: {},
    rapidClicks: 0,
    lastClickAt: 0,
  };
}

export function usePetWorld(stageRef: Ref<HTMLElement | null>) {
  const pets = reactive<PetInstance[]>([]);
  const isPaused = ref(false);
  const bounds = reactive<StageBounds>({ width: 960, height: 640 });
  let raf = 0;
  let lastTime = 0;
  let spawnIndex = 0;

  const activeCount = computed(() => pets.length);

  function readBounds(): StageBounds {
    const rect = stageRef.value?.getBoundingClientRect();
    bounds.width = rect?.width ?? window.innerWidth;
    bounds.height = rect?.height ?? window.innerHeight;
    return bounds;
  }

  function retarget(pet: PetInstance): void {
    // 子 pet：聚拢本主（部落扎堆）；主 pet / 孤儿子：自由游走
    const master = pet.isMaster ? undefined : findMaster(pet);
    if (master) {
      pet.targetX = clamp(master.x + rand(-TRIBE_CLUSTER_RADIUS, TRIBE_CLUSTER_RADIUS), 0, Math.max(0, bounds.width - pet.width));
      pet.targetY = clamp(master.y + rand(-TRIBE_CLUSTER_RADIUS, TRIBE_CLUSTER_RADIUS), 42, Math.max(42, bounds.height - pet.height));
      return;
    }
    const target = randomTarget(bounds);
    pet.targetX = target.x;
    pet.targetY = target.y;
  }

  function showSpeech(pet: PetInstance, text: string, duration = 1800): void {
    const now = performance.now();
    pet.speech = text;
    pet.speechUntil = now + duration;
  }

  function setTemporaryAction(pet: PetInstance, action: PetAction, duration = 1200, speech?: string): void {
    const now = performance.now();
    pet.action = action;
    pet.mood = moodForAction(action);
    pet.moodUntil = now + duration;
    pet.lastInteractionAt = now;
    if (speech) showSpeech(pet, speech, duration);
  }

  function fallAsleep(pet: PetInstance): void {
    pet.action = "sleep";
    pet.mood = "sleepy";
    pet.moodUntil = 0;
    pet.speech = "";
    pet.speechUntil = 0;
  }

  function wakeUp(pet: PetInstance): void {
    const now = performance.now();
    pet.action = "walk";
    pet.mood = restMood(pet);
    pet.moodUntil = 0;
    pet.lastInteractionAt = now;
    retarget(pet);
    showSpeech(pet, pick(["醒了", "嗯?", "zZ..."]), 800);
  }

  function findMaster(pet: PetInstance): PetInstance | undefined {
    if (pet.isMaster) return pet;
    return pets.find((p) => p.instanceId === pet.tribe && p.isMaster);
  }

  // 工具栏 +pet：新主 pet（新部落）
  function addPet(): void {
    const preset = generatePet("kaomoji");
    pets.push(createPet(preset, readBounds(), spawnIndex, true));
    spawnIndex += 1;
  }

  // 主 pet summon：召子 pet 加入本部落，落点在主附近
  function summonSub(master: PetInstance): void {
    const preset = generatePet("emoji");
    const sub = createPet(preset, readBounds(), spawnIndex, false, master.instanceId);
    const pos = findSpawnPosition({ x: master.x, y: master.y }, pets, bounds);
    sub.x = pos.x;
    sub.y = pos.y;
    sub.targetX = pos.x;
    sub.targetY = pos.y;
    pets.push(sub);
    spawnIndex += 1;
  }

  function removePet(pet: PetInstance): void {
    const idx = pets.findIndex((p) => p.instanceId === pet.instanceId);
    if (idx >= 0) pets.splice(idx, 1);
    // 主被驱逐 → 其子成为孤儿（tribe 找不到主 → 无吸引，自由游走），不连带驱逐、不自动归并
  }

  function resetPets(): void {
    pets.splice(0, pets.length);
    const b = readBounds();
    // 2 主 + 每主 1~2 子
    for (let m = 0; m < 2; m += 1) {
      const preset = generatePet("kaomoji");
      const master = createPet(preset, b, spawnIndex, true);
      const masterPos = findSpawnPosition(randomTarget(b), pets, b);
      master.x = masterPos.x;
      master.y = masterPos.y;
      pets.push(master);
      spawnIndex += 1;
      const subCount = 1 + (spawnIndex % 2);
      for (let s = 0; s < subCount; s += 1) {
        const subPreset = generatePet("emoji");
        const sub = createPet(subPreset, b, spawnIndex, false, master.instanceId);
        const subPos = findSpawnPosition({ x: master.x, y: master.y }, pets, b);
        sub.x = subPos.x;
        sub.y = subPos.y;
        sub.targetX = subPos.x;
        sub.targetY = subPos.y;
        pets.push(sub);
        spawnIndex += 1;
      }
    }
  }

  function randomEmotion(): void {
    const moods: PetMood[] = [
      "happy", "surprised", "sad", "panicked", "angry", "nagging", "curious", "serious", "sleepy",
    ];
    for (const pet of pets) {
      const mood = pick(moods);
      pet.mood = mood;
      pet.action = mood === "sleepy" ? "sleep" : "clicked";
      pet.moodUntil = performance.now() + rand(1100, 2400);
      showSpeech(pet, pick(pet.talks), 1600);
    }
  }

  function togglePause(): void {
    isPaused.value = !isPaused.value;
  }

  function faceEachOther(a: PetInstance, b: PetInstance): void {
    a.direction = a.x <= b.x ? 1 : -1;
    b.direction = b.x <= a.x ? 1 : -1;
  }

  function triggerChat(a: PetInstance, b: PetInstance, now: number): void {
    const until = now + rand(CHAT_DURATION_MIN, CHAT_DURATION_MAX);
    const cooldownUntil = until + CHAT_COOLDOWN;
    a.pairCooldowns[b.instanceId] = cooldownUntil;
    b.pairCooldowns[a.instanceId] = cooldownUntil;
    a.action = "chatting";
    b.action = "chatting";
    a.mood = pick(["happy", "nagging", "curious"] as const);
    b.mood = pick(["happy", "nagging", "curious"] as const);
    a.interactionUntil = until;
    b.interactionUntil = until;
    a.lastInteractionAt = now;
    b.lastInteractionAt = now;
    adjustFatigue(a, FATIGUE_CHAT);
    adjustFatigue(b, FATIGUE_CHAT);
    faceEachOther(a, b);
    showSpeech(a, pick(a.talks), until - now);
    showSpeech(b, pick(b.talks), until - now);
  }

  function maybeTriggerChats(now: number): void {
    const candidates: Array<{ a: PetInstance; b: PetInstance; dist: number }> = [];

    for (let i = 0; i < pets.length; i += 1) {
      const a = pets[i];
      if (!a || a.draggingPointerId !== null || a.action === "chatting" || a.action === "sleep" || a.action === "hover") continue;
      for (let j = i + 1; j < pets.length; j += 1) {
        const b = pets[j];
        if (!b || b.draggingPointerId !== null || b.action === "chatting" || b.action === "sleep" || b.action === "hover") continue;
        const pairCooling = (a.pairCooldowns[b.instanceId] ?? 0) > now || (b.pairCooldowns[a.instanceId] ?? 0) > now;
        if (pairCooling) continue;
        const dist = distance(a, b);
        if (dist < CHAT_DISTANCE) {
          candidates.push({ a, b, dist });
        }
      }
    }

    candidates.sort((left, right) => left.dist - right.dist);
    const pair = candidates[0];
    if (pair) triggerChat(pair.a, pair.b, now);
  }

  function tickPet(pet: PetInstance, now: number, dt: number): void {
    if (pet.draggingPointerId !== null) {
      return;
    }

    // 休息中：速度 0，fatigue↓ emotion↑，自然醒
    if (pet.action === "sleep") {
      adjustFatigue(pet, -FATIGUE_RECOVER * dt);
      adjustEmotion(pet, EMOTION_RECOVER * dt);
      if (pet.fatigue <= FATIGUE_WAKE) {
        wakeUp(pet);
      }
      return;
    }

    // 悬浮：停止移动，保持当前表情（不切 mood、不衰减、不回退）
    if (pet.action === "hover") return;

    // emotion 缓降
    adjustEmotion(pet, -EMOTION_DECAY * dt);

    // 疲劳达阈值 → 自动休息
    if (pet.fatigue >= FATIGUE_SLEEP) {
      fallAsleep(pet);
      return;
    }

    if (pet.speech && pet.speechUntil < now) {
      pet.speech = "";
    }

    if (pet.action === "chatting") {
      if (pet.interactionUntil < now) {
        pet.action = "walk";
        pet.mood = restMood(pet);
        retarget(pet);
      }
      return;
    }

    if (pet.moodUntil && pet.moodUntil < now) {
      pet.action = "walk";
      pet.mood = restMood(pet);
      pet.moodUntil = 0;
    }

    if (arrivedAtTarget(pet)) {
      retarget(pet);
      pet.action = "idle";
      pet.mood = restMood(pet);
      pet.moodUntil = now + rand(800, 1800);
      pet.vx = 0;
      pet.vy = 0;
      return;
    }

    pet.action = "walk";
    adjustFatigue(pet, FATIGUE_WALK_RATE * dt);
    const baseMax = pet.mood === "sleepy" ? 55 : 115;
    const maxSpeed = baseMax * (1 + (pet.id.length % 3) * 0.15);
    if (pet.isMaster) {
      // 主 pet 独立物理：更慢更稳（更低速度/加速度/斥力/半径）
      stepMovement(pet, pets, bounds, dt, {
        maxSpeed: maxSpeed * 0.6,
        acceleration: MASTER_ACCELERATION,
        tribeRepel: MASTER_TRIBE_REPEL,
        otherRepel: MASTER_OTHER_REPEL,
        repelRadius: MASTER_REPEL_RADIUS,
        attractRadius: MASTER_ATTRACT_RADIUS,
      });
    } else {
      stepMovement(pet, pets, bounds, dt, { maxSpeed });
    }
  }

  function loop(now: number): void {
    const currentBounds = readBounds();
    const dt = Math.min(0.04, Math.max(0, (now - lastTime) / 1000 || 0));
    lastTime = now;

    if (!isPaused.value && currentBounds.width > 0 && currentBounds.height > 0) {
      maybeTriggerChats(now);
      for (const pet of pets) {
        tickPet(pet, now, dt);
      }
    }

    raf = requestAnimationFrame(loop);
  }

  function pointerPosition(event: PointerEvent): { x: number; y: number } {
    const rect = stageRef.value?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
    };
  }

  function startDrag(pet: PetInstance, event: PointerEvent): void {
    const wasSleeping = pet.action === "sleep";
    const point = pointerPosition(event);
    pet.draggingPointerId = event.pointerId;
    pet.dragOffsetX = point.x - pet.x;
    pet.dragOffsetY = point.y - pet.y;
    pet.action = "dragging";
    pet.mood = "surprised";
    pet.moodUntil = 0;
    pet.lastInteractionAt = performance.now();
    if (wasSleeping) {
      adjustEmotion(pet, EMOTE_DISTURB);
    }
    adjustEmotion(pet, EMOTE_DRAG);
    showSpeech(pet, actionTalk(pet, "dragging"), 900);
  }

  function dragPet(pet: PetInstance, event: PointerEvent): void {
    if (pet.draggingPointerId !== event.pointerId) return;
    const point = pointerPosition(event);
    pet.x = point.x - pet.dragOffsetX;
    pet.y = point.y - pet.dragOffsetY;
    // direction 滞回：忽略微小 movementX 噪声，避免 scaleX 频繁翻转抖动
    if (Math.abs(event.movementX) > 2) {
      pet.direction = event.movementX > 0 ? 1 : -1;
    }
    // fatigue 按位移累积
    const moved = Math.hypot(event.movementX, event.movementY);
    if (moved > 0) adjustFatigue(pet, moved * 0.05);
    // mood 不每帧切：仅持续快移切 panicked，保底保持 400ms 避免闪烁
    const now = performance.now();
    if (moved > PANIC_MOVEMENT && pet.mood !== "panicked") {
      pet.mood = "panicked";
      pet.moodUntil = now + 400;
    } else if (pet.mood === "panicked" && pet.moodUntil && pet.moodUntil < now) {
      pet.mood = "surprised";
    }
    keepInBounds(pet, bounds);
  }

  function endDrag(pet: PetInstance, event: PointerEvent): void {
    if (pet.draggingPointerId !== event.pointerId) return;
    pet.draggingPointerId = null;
    pet.dragOffsetX = 0;
    pet.dragOffsetY = 0;
    keepInBounds(pet, bounds);
    setTemporaryAction(pet, "dropped", 900, actionTalk(pet, "dropped"));
    retarget(pet);
  }

  function hoverPet(pet: PetInstance, hovering: boolean): void {
    if (pet.draggingPointerId !== null) return;
    const now = performance.now();
    if (hovering) {
      if (pet.action === "sleep") {
        wakeUp(pet);
        adjustEmotion(pet, EMOTE_DISTURB);
        return;
      }
      if (pet.action === "chatting") return;
      pet.action = "hover";
      pet.lastInteractionAt = now;
      adjustEmotion(pet, EMOTE_HOVER);
    } else if (pet.action === "hover") {
      pet.action = "walk";
      pet.mood = restMood(pet);
    }
  }

  function clickPet(pet: PetInstance): void {
    if (pet.draggingPointerId !== null) return;
    const now = performance.now();
    if (pet.action === "sleep") {
      wakeUp(pet);
      adjustEmotion(pet, EMOTE_DISTURB);
      return;
    }
    pet.rapidClicks = now - pet.lastClickAt < RAPID_CLICK_WINDOW ? pet.rapidClicks + 1 : 1;
    pet.lastClickAt = now;
    if (pet.rapidClicks >= RAPID_CLICK_THRESHOLD) {
      pet.mood = "angry";
      pet.action = "clicked";
      pet.moodUntil = now + 1400;
      pet.lastInteractionAt = now;
      adjustEmotion(pet, EMOTE_RAPID);
      showSpeech(pet, pick(["够了!", "别戳!", "哼!"]), 1300);
      return;
    }
    adjustEmotion(pet, EMOTE_CLICK);
    setTemporaryAction(pet, "clicked", 1300, actionTalk(pet, "clicked"));
  }

  function invokeTool(pet: PetInstance, toolId: string): void {
    const now = performance.now();
    switch (toolId) {
      case "pet":
        if (pet.action === "sleep") wakeUp(pet);
        adjustEmotion(pet, EMOTE_PET);
        setTemporaryAction(pet, "clicked", 1300, actionTalk(pet, "clicked"));
        break;
      case "feed":
        if (pet.action === "sleep") wakeUp(pet);
        pet.mood = "happy";
        pet.action = "clicked";
        pet.moodUntil = now + 1400;
        pet.lastInteractionAt = now;
        adjustEmotion(pet, EMOTE_FEED);
        showSpeech(pet, pick(["好吃!", "嗯~", "再来!"]), 1500);
        break;
      case "sleep":
        fallAsleep(pet);
        break;
      case "punch":
        if (pet.action === "sleep") wakeUp(pet);
        pet.mood = "angry";
        pet.action = "clicked";
        pet.moodUntil = now + 1200;
        pet.lastInteractionAt = now;
        adjustEmotion(pet, EMOTE_PUNCH);
        showSpeech(pet, pick(["嘿!", "气!", "哼!"]), 1200);
        break;
      case "dismiss":
        removePet(pet);
        break;
      case "summon":
        summonSub(pet);
        break;
      default:
        break;
    }
  }

  // agent 显示层预留：未来由真实 token 上下文 / agent 状态注入
  function setFatigue(pet: PetInstance, value: number): void {
    pet.fatigue = clamp(value, 0, 100);
  }

  function setEmotion(pet: PetInstance, value: number): void {
    pet.emotion = clamp(value, 0, 100);
  }

  onMounted(() => {
    readBounds();
    if (pets.length === 0) {
      resetPets();
    }
    lastTime = performance.now();
    raf = requestAnimationFrame(loop);
    window.addEventListener("resize", readBounds);
  });

  onUnmounted(() => {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", readBounds);
  });

  return {
    pets,
    isPaused,
    activeCount,
    addPet,
    removePet,
    resetPets,
    randomEmotion,
    togglePause,
    invokeTool,
    setFatigue,
    setEmotion,
    startDrag,
    dragPet,
    endDrag,
    hoverPet,
    clickPet,
  };
}
