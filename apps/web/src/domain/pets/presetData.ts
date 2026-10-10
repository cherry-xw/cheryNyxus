import type { PetHands, PetMood } from './types'

// ===== face 部件（中央表情；emoji 角色为整 emoji，颜文字角色为眼睛/嘴部件） =====
// 现有 15 套保留为 face 部件源；新增 8 套动物/人物 emoji 进子池（mood 近似映射）。

const bearFace: Record<PetMood, string> = {
  calm: '•ᴥ•',
  serious: '•ᴥ•',
  happy: 'ᵔᴥᵔ',
  surprised: '•o•',
  sad: '•̥ᴥ•̥',
  panicked: '°Д°',
  angry: '>ᴥ<',
  nagging: '︿ᴥ︿',
  curious: '•ᴥ•?',
  sleepy: '-ᴥ-',
}

const catFace: Record<PetMood, string> = {
  calm: '😺',
  serious: '😾',
  happy: '😻',
  surprised: '😹',
  sad: '😿',
  panicked: '🙀',
  angry: '😼',
  nagging: '😸',
  curious: '😽',
  sleepy: '😴',
}

const smileyFace: Record<PetMood, string> = {
  calm: '🙂',
  serious: '😐',
  happy: '😄',
  surprised: '😮',
  sad: '😢',
  panicked: '😱',
  angry: '😠',
  nagging: '🙄',
  curious: '🤔',
  sleepy: '😴',
}

const winkFace: Record<PetMood, string> = {
  calm: '😉',
  serious: '😏',
  happy: '😆',
  surprised: '😲',
  sad: '😔',
  panicked: '😨',
  angry: '😤',
  nagging: '😒',
  curious: '🧐',
  sleepy: '😴',
}

const loveFace: Record<PetMood, string> = {
  calm: '😍',
  serious: '🥰',
  happy: '😘',
  surprised: '😲',
  sad: '🥺',
  panicked: '😱',
  angry: '😡',
  nagging: '😒',
  curious: '🤔',
  sleepy: '😴',
}

const coolFace: Record<PetMood, string> = {
  calm: '😎',
  serious: '🤓',
  happy: '🤩',
  surprised: '😲',
  sad: '😎',
  panicked: '😱',
  angry: '😠',
  nagging: '🙄',
  curious: '🧐',
  sleepy: '😴',
}

const partyFace: Record<PetMood, string> = {
  calm: '🥳',
  serious: '😎',
  happy: '🤩',
  surprised: '😲',
  sad: '😢',
  panicked: '😱',
  angry: '😠',
  nagging: '🙄',
  curious: '🤔',
  sleepy: '😴',
}

const zanyFace: Record<PetMood, string> = {
  calm: '🤪',
  serious: '🤨',
  happy: '😜',
  surprised: '🤯',
  sad: '🥴',
  panicked: '😱',
  angry: '😠',
  nagging: '🙄',
  curious: '🤔',
  sleepy: '😴',
}

const robotFace: Record<PetMood, string> = {
  calm: '•-•',
  serious: '▬-▬',
  happy: '◕ᴗ◕',
  surprised: '•o•',
  sad: '•-•',
  panicked: '°Д°',
  angry: '>д<',
  nagging: '•﹏•',
  curious: '•?•',
  sleepy: '_-_',
}

const roundFace: Record<PetMood, string> = {
  calm: '•̀ᴗ•',
  serious: '•́̀ᴗ•́̀',
  happy: '˃ᴗ˂',
  surprised: '•̀⌓•',
  sad: '•̥ᴗ•̥',
  panicked: '°⌓°',
  angry: '•́̀д•́̀',
  nagging: '˙³˙',
  curious: '•̀?•',
  sleepy: '˘ᴗ˘',
}

const bunnyFace: Record<PetMood, string> = {
  calm: '•ᴗ•',
  serious: '•ᴗ•',
  happy: 'ᵔᴗᵔ',
  surprised: '•o•',
  sad: '•̥ᴗ•̥',
  panicked: '°Д°',
  angry: '>ᗗ<',
  nagging: '︿ᴗ︿',
  curious: '•ᴗ•?',
  sleepy: '-ᴗ-',
}

const lennyFace: Record<PetMood, string> = {
  calm: ' ͡° ͜ʖ ͡°',
  serious: ' ͡° ͜ʖ ͡°',
  happy: ' ͡ᵔ ͜ʖ ͡ᵔ',
  surprised: ' ͡° ͜ʖ ͡°',
  sad: ' ͡° ͜ʖ ͡°',
  panicked: ' ͡Д ͜ʖ ͡Д',
  angry: ' ͡> ͜ʖ ͡<',
  nagging: ' ͡~ ͜ʖ ͡~',
  curious: ' ͡? ͜ʖ ͡?',
  sleepy: ' ͡- ͜ʖ ͡-',
}

const dogeFace: Record<PetMood, string> = {
  calm: '•ω•',
  serious: '•ω•',
  happy: '^ω^',
  surprised: '°ω°',
  sad: '•̥ω•̥',
  panicked: '°Д°',
  angry: '>ω<',
  nagging: '︿ω︿',
  curious: '•ω•?',
  sleepy: '-ω-',
}

const muscleFace: Record<PetMood, string> = {
  calm: '•̀ᴗ•́',
  serious: '•̀ᴗ•́',
  happy: '•̀ʊ•́',
  surprised: '•̀o•́',
  sad: '•̥ᴗ•̥',
  panicked: '°Д°',
  angry: '•̀Д•́',
  nagging: '•﹏•',
  curious: '•̀?•́',
  sleepy: '-ᴗ-',
}

const foxFace: Record<PetMood, string> = {
  calm: '^•ω•^',
  serious: '^•ω•^',
  happy: '^ᵔωᵔ^',
  surprised: '^•o•^',
  sad: '^•̥ω•̥^',
  panicked: '^°Д°^',
  angry: '^>ω<^',
  nagging: '^︿ω︿^',
  curious: '^•ω•?^',
  sleepy: '^-ω-^',
}

// --- 新增 emoji face（子池；动物 mood 近似映射：calm/serious/happy 用本动物 emoji，极性情绪用表情 emoji） ---

const dogFace: Record<PetMood, string> = {
  calm: '🐶',
  serious: '🐕',
  happy: '🐕',
  surprised: '😮',
  sad: '😢',
  panicked: '😨',
  angry: '😠',
  nagging: '😒',
  curious: '🤔',
  sleepy: '😴',
}

const pandaFace: Record<PetMood, string> = {
  calm: '🐼',
  serious: '🐼',
  happy: '🐼',
  surprised: '😲',
  sad: '🥺',
  panicked: '😱',
  angry: '😤',
  nagging: '🙄',
  curious: '🧐',
  sleepy: '🥱',
}

const frogFace: Record<PetMood, string> = {
  calm: '🐸',
  serious: '🐸',
  happy: '🐸',
  surprised: '🤯',
  sad: '😢',
  panicked: '😱',
  angry: '😡',
  nagging: '😒',
  curious: '🤔',
  sleepy: '😴',
}

const monkeyFace: Record<PetMood, string> = {
  calm: '🐵',
  serious: '🐵',
  happy: '🙈',
  surprised: '😮',
  sad: '🥺',
  panicked: '😨',
  angry: '😠',
  nagging: '🙄',
  curious: '👀',
  sleepy: '😴',
}

const owlFace: Record<PetMood, string> = {
  calm: '🦉',
  serious: '🦉',
  happy: '🦉',
  surprised: '😲',
  sad: '😢',
  panicked: '😱',
  angry: '😤',
  nagging: '😒',
  curious: '🧐',
  sleepy: '🥱',
}

const unicornFace: Record<PetMood, string> = {
  calm: '🦄',
  serious: '🦄',
  happy: '🦄',
  surprised: '🤯',
  sad: '🥺',
  panicked: '😨',
  angry: '😡',
  nagging: '🙄',
  curious: '🤔',
  sleepy: '😴',
}

const ghostFace: Record<PetMood, string> = {
  calm: '👻',
  serious: '👻',
  happy: '👻',
  surprised: '😲',
  sad: '🥺',
  panicked: '😱',
  angry: '😠',
  nagging: '😒',
  curious: '🧐',
  sleepy: '😴',
}

const alienFace: Record<PetMood, string> = {
  calm: '👽',
  serious: '👽',
  happy: '👽',
  surprised: '🤯',
  sad: '😢',
  panicked: '😨',
  angry: '😤',
  nagging: '🙄',
  curious: '👀',
  sleepy: '🥱',
}

// ===== face 部件池（主池 = kaomoji，子池 = emoji） =====

export const KAOMOJI_FACES: Record<PetMood, string>[] = [
  bearFace,
  robotFace,
  roundFace,
  bunnyFace,
  lennyFace,
  dogeFace,
  muscleFace,
  foxFace,
]

export const EMOJI_FACES: Record<PetMood, string>[] = [
  catFace,
  smileyFace,
  winkFace,
  loveFace,
  coolFace,
  partyFace,
  zanyFace,
  dogFace,
  pandaFace,
  frogFace,
  monkeyFace,
  owlFace,
  unicornFace,
  ghostFace,
  alienFace,
]

// ===== HAND_PAIRS（情绪关联手部字符；配对池，每 mood 抽一对） =====
// 字符源自 lddgo.net/common/emoticons 颜文字手臂/装饰 + emoji 动效。
// 动效 mood 映射：跑→happy/panicked（ε=┏┛/🏃）、汗→surprised/panicked（💦/Σ/|||）、
// 放屁→nagging（○|￣|_=3/💨）、哭→sad（😭/💧/╥/〒）、掀桌→angry（┻━┻）。

export const HAND_PAIRS: Record<PetMood, PetHands[]> = {
  calm: [
    { left: '(', right: ')' },
    { left: '・', right: '・' },
    { left: '=￣', right: '￣=' },
    { left: '（', right: '）' },
    { left: '✿', right: '✿' },
    { left: '（´', right: '`）' },
    { left: '￣', right: '￣' },
    { left: 'o', right: 'o' },
  ],
  serious: [
    { left: '|', right: '|' },
    { left: '│', right: '│' },
    { left: '━', right: '━' },
    { left: '╢', right: '╟' },
    { left: '[', right: ']' },
    { left: '▔', right: '▔' },
    { left: '─', right: '─' },
    { left: '╪', right: '╪' },
  ],
  happy: [
    { left: 'ヾ(', right: ')o' },
    { left: '(', right: ')و✧' },
    { left: '︿(', right: ')︿' },
    { left: '✨', right: '✨' },
    { left: '♪', right: '♪' },
    { left: 'φ(', right: ')♪' },
    { left: '☆', right: '☆' },
    { left: '🏃', right: '🏃' },
  ],
  surprised: [
    { left: 'Σ(', right: ')' },
    { left: 'w(', right: ')w' },
    { left: '💦', right: '💦' },
    { left: '⊙', right: '⊙' },
    { left: 'Σ(', right: ';)' },
    { left: '|||', right: '|||' },
    { left: '°', right: '°' },
    { left: 'O', right: 'O' },
  ],
  sad: [
    { left: '(', right: ')' },
    { left: '╥', right: '╥' },
    { left: 'o(T', right: 'To)' },
    { left: ';;', right: ';;' },
    { left: '💧', right: '💧' },
    { left: '〒', right: '〒' },
    { left: '(ﾉ', right: '、)' },
  ],
  panicked: [
    { left: 'ε=ε=ε=┏(', right: ')┛' },
    { left: 'ε=ε=ε=(', right: ')~' },
    { left: '💦', right: '💦' },
    { left: 'Σ(', right: ')' },
    { left: '━', right: '━' },
    { left: '╥', right: '╥' },
    { left: 'ヽ(', right: ')ﾉ' },
  ],
  angry: [
    { left: '╰(', right: ')╯' },
    { left: '╬', right: '╬' },
    { left: '凸(', right: ')' },
    { left: '╮(', right: ')╭' },
    { left: '👊', right: '👊' },
    { left: '💢', right: '💢' },
    { left: '┻━┻', right: '┻━┻' },
    { left: '╬▔', right: '▔╬' },
  ],
  nagging: [
    { left: '╮(', right: ')╭' },
    { left: '○|￣|_', right: '=3' },
    { left: '💨', right: '💨' },
    { left: '🎵', right: '🎵' },
    { left: '~~(', right: ')~~' },
    { left: '(﹁', right: '﹁)' },
    { left: '💩', right: '💩' },
    { left: '~', right: '~' },
  ],
  curious: [
    { left: 'ᕕ(', right: ')ᕗ' },
    { left: 'ᕙ', right: 'ᕘ' },
    { left: '┬┴', right: '┬┴' },
    { left: 'ζ', right: 'ζ' },
    { left: '👀', right: '👀' },
    { left: '?', right: '?' },
    { left: '(・', right: '・)' },
    { left: '⊙', right: '⊙' },
  ],
  sleepy: [
    { left: 'z(', right: ')z' },
    { left: 'Zz', right: 'zZ' },
    { left: '(￣o', right: 'o￣)' },
    { left: '~', right: '~' },
    { left: '＿', right: '＿' },
    { left: '(∪｡', right: '｡∪)' },
    { left: 'z', right: 'z' },
    { left: '.', right: '.' },
  ],
}

// ===== COLOR_PARTS（color/accent 对，从原 15 preset 提取） =====

export const COLOR_PARTS: { color: string; accent: string }[] = [
  { color: '#5b6b8c', accent: '#2b3550' },
  { color: '#ff8aa6', accent: '#54162a' },
  { color: '#22d3ee', accent: '#04202b' },
  { color: '#63c7b2', accent: '#0b3d36' },
  { color: '#9e8cff', accent: '#261d57' },
  { color: '#b8e0ff', accent: '#1f4a6b' },
  { color: '#e8a13c', accent: '#5a3d10' },
  { color: '#d9b38c', accent: '#5e4326' },
  { color: '#e0635a', accent: '#5e1d1a' },
  { color: '#c97b4a', accent: '#4a2a14' },
  { color: '#b388ff', accent: '#3a2570' },
  { color: '#ff6f91', accent: '#5a1230' },
  { color: '#4a6fa5', accent: '#1a2d4a' },
  { color: '#ffd54f', accent: '#5a4310' },
  { color: '#7fd97f', accent: '#1f4a1f' },
]

// ===== TALK_PARTS（台词池；原 15 talks + 参考短词） =====

export const TALK_PARTS: string[][] = [
  ['领命', '照办', '嗯哼', '在'],
  ['nya', '喵', '贴贴', '?'],
  ['hi', '♪', 'nice', 'yo'],
  ['ping', 'beep', 'sync?', '0x'],
  ['boo', '...', 'wow', 'heh'],
  ['hop', '♪', '跳?', 'squeak'],
  ['( ͡° ͜ʖ ͡°)', 'hmm', 'eyy', '...'],
  ['wow', 'such', 'doge', '很究'],
  ['抓稳', '嘿!', '练不练?', '加把劲'],
  ['yip', '哼', '嘿嘿', '?'],
  ['wink', '嘿', '~', '✨'],
  ['love', '♥', '亲', '~'],
  ['cool', 'yo', '稳', '~'],
  ['party!', '🎉', '嗨', '~'],
  ['nya~', '哇', '!', '?'],
  // 参考短词（lddgo.net/common/emoticons 标签）
  ['嗷', '棒', '擦', '汗', '笨', '飞', '啦啦', '嗯哪'],
  ['喵', '喵呜', 'orz', '切', '哼', '败了', 'Hia hia'],
  ['放屁', '掀桌', '拍桌', '逃', '好耶', '拜拜', '啵啵'],
]

// ===== NAME_POOL =====

export const NAME_POOL: string[] = [
  'stewart',
  'momo',
  'spark',
  'byte',
  'boo',
  'pip',
  'lenny',
  'shiba',
  'pump',
  'fox',
  'wink',
  'love',
  'cool',
  'party',
  'zany',
  'mochi',
  'nori',
  'toto',
  'zuzu',
  'bobo',
  'lulu',
  'kiki',
  'fufu',
  'mimi',
  'coco',
  'pepper',
  'ginger',
  'olive',
  'clover',
  'hazel',
  'remy',
  'scout',
  'willow',
  'jasper',
  'nova',
]

// ===== MASTER_NAME_POOL（主 pet 专属） =====
// 主 pet name 按 chatId 确定性取：MASTER_NAME_POOL[hashStr(chatId) % len]。
// 刷新稳定（chatId 不变→name 不变），不同主 pet 大概率异名。与 NAME_POOL（子 pet 随机）独立，重叠无害。
export const MASTER_NAME_POOL: string[] = [
  // 食物甜点
  'mochi',
  'matcha',
  'boba',
  'tofu',
  'waffle',
  'pancake',
  'muffin',
  'cookie',
  'brownie',
  'pudding',
  'caramel',
  'truffle',
  'donut',
  'bagel',
  'macaron',
  'eclair',
  'strudel',
  'churro',
  'scone',
  'fudge',
  // 香料
  'pepper',
  'ginger',
  'cinnamon',
  'nutmeg',
  'clove',
  'basil',
  'mint',
  'pistachio',
  'sage',
  'thyme',
  'saffron',
  'rosemary',
  'anise',
  'wasabi',
  'cardamom',
  // 自然草木
  'willow',
  'hazel',
  'ivy',
  'poppy',
  'daisy',
  'fern',
  'olive',
  'clover',
  'maple',
  'birch',
  'cedar',
  'rowan',
  'aspen',
  'juniper',
  'briar',
  // 星空宇宙
  'nova',
  'comet',
  'nebula',
  'orbit',
  'cosmo',
  'luna',
  'stella',
  'aurora',
  'zenith',
  'eclipse',
  // 科技能量
  'pixel',
  'byte',
  'spark',
  'bolt',
  'dash',
  'turbo',
  'echo',
  'neo',
  'vortex',
  'glimmer',
  // 角色拟人
  'atlas',
  'jasper',
  'remy',
  'scout',
  'oscar',
  'milo',
  'finn',
  'hugo',
  'theo',
  'oliver',
  'winston',
  'buford',
  'otis',
  'leon',
  'felix',
  // 可爱拟声
  'momo',
  'boo',
  'pip',
  'bobo',
  'lulu',
  'kiki',
  'mimi',
  'toto',
  'zuzu',
  'fufu',
  'nori',
  'pebble',
  'nugget',
  'wobble',
  'biscuit',
]

// ===== 工具 =====

export const TOOL = {
  pet: { id: 'pet', icon: '🤚', label: '抚摸', core: true },
  feed: { id: 'feed', icon: '🍖', label: '喂食', core: true },
  sleep: { id: 'sleep', icon: '💤', label: '哄睡' },
  punch: { id: 'punch', icon: '👊', label: '挑逗' },
  dismiss: { id: 'dismiss', icon: '✕', label: '驱逐' },
  summon: { id: 'summon', icon: '➕', label: '召伙伴', core: true },
}
