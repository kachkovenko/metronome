// Metronome — Web Audio API scheduler with lookahead.
// Reference: Chris Wilson, "A Tale of Two Clocks".

const APP_VERSION = '1.22.0';

const state = {
  bpm: 100,
  beatsPerMeasure: 4,
  beatUnit: 4,
  subdivision: 1,
  // Per-beat type: 'accent' | 'beat' | 'soft' | 'mute'
  beatTypes: ['accent', 'beat', 'beat', 'beat'],
  isPlaying: false,
  currentBeat: 0,
  currentSub: 0,

  volMaster: 1.0,
  volAccent: 1.0,
  volBeat: 0.7,
  volSub: 0.4,

  trainerEnabled: false,
  trainerStart: 80,
  trainerEnd: 140,
  trainerStep: 5,
  trainerBars: 4,
  trainerBarCount: 0,

  muteEnabled: false,
  mutePlayBars: 2,
  muteSkipBars: 1,
  muteBarCount: 0,

  // Identifier of the currently-applied preset, or null. Format: "builtin:N" / "user:N".
  // Cleared when the user touches the metronome and the new state diverges from the preset
  // (checked on entering the Settings tab).
  activePresetSig: null,

  // Bluetooth output latency (ms). Visual indicator is delayed by this much
  // so the flash matches when the click actually arrives in the listener's ear.
  btLatencyMs: 0,
  // When true, pull the value from audioCtx.outputLatency on each start();
  // when false, the manual slider is canonical.
  autoBtLatency: true,

  // Microphone-based timing trainer (Stage 1 MVP)
  micEnabled: false,
  // System input latency compensation in ms (Stage 2 will add calibration UI)
  inputLatencyMs: 0,

  // Fullscreen flash mode (lamp toggle inside fullscreen view)
  flashEnabled: false,

  // Count-in (delayed start with audible click-through)
  countinActive: false,
  countinTimer: null,
  countinSec: 0,

  // Sound profile per beat type (key from SOUND_TYPES)
  soundAccent: 'click',
  soundBeat: 'click',
};

const BT_LATENCY_KEY = 'metronome.bt-latency-ms';
const BT_AUTO_KEY = 'metronome.bt-auto';
const INPUT_LATENCY_KEY = 'metronome.input-latency-ms';
const THEME_KEY = 'metronome.theme';
const SOUND_ACCENT_KEY = 'metronome.sound-accent';
const SOUND_BEAT_KEY = 'metronome.sound-beat';
const ANALYTICS_DISABLED_KEY = 'metronome.analytics-disabled';
const USER_PROGRAMS_KEY = 'metronome.user-programs';

// Settings keys cleared by "Сброс настроек". User content (saved
// rhythms, BPM presets) is intentionally NOT in this list.
const RESETTABLE_KEYS = [
  BT_LATENCY_KEY, BT_AUTO_KEY, INPUT_LATENCY_KEY,
  THEME_KEY, SOUND_ACCENT_KEY, SOUND_BEAT_KEY,
  ANALYTICS_DISABLED_KEY,
];

const THEME_COLORS = { dark: '#000000', light: '#f5f5f7' };

// Click-sound profiles. Frequency stays per beat type (accent=1500, beat=900);
// these only swap the oscillator waveform, which gives perceptibly different
// timbres without overcomplicating the synth path.
const SOUND_TYPES = {
  click: { label: 'Клик',   wave: 'square' },
  wood:  { label: 'Дерево', wave: 'triangle' },
  beep:  { label: 'Бип',    wave: 'sine' },
};

let audioCtx = null;
let silentAudio = null;
let wakeLockSentinel = null;
const SCHEDULE_AHEAD = 0.1;
const LOOKAHEAD_MS = 25;
let nextNoteTime = 0;
let timerID = null;
const notesInQueue = [];

const $ = (id) => document.getElementById(id);

const SUB_META = {
  1: { symbol: '♩', label: 'четверти' },
  2: { symbol: '♫', label: 'восьмые' },
  3: { symbol: '♪³', label: 'триоли' },
  4: { symbol: '♬', label: 'шестнадцатые' },
};

const TIME_NUMERATORS = [2, 3, 4, 5, 6, 7, 8, 9, 12];
const TIME_DENOMINATORS = [2, 4, 8, 16];

const BUILTIN_PRESETS = [
  { name: 'Медленно (60, 4/4)', bpm: 60, num: 4, den: 4, sub: 1 },
  { name: 'Восьмые (90, 4/4)', bpm: 90, num: 4, den: 4, sub: 2 },
  { name: 'Триоли (90, 4/4)', bpm: 90, num: 4, den: 4, sub: 3 },
  { name: 'Шестнадцатые (90, 4/4)', bpm: 90, num: 4, den: 4, sub: 4 },
  { name: 'Вальс (120, 3/4)', bpm: 120, num: 3, den: 4, sub: 1 },
  { name: 'Шаффл (110, 4/4 ♪³)', bpm: 110, num: 4, den: 4, sub: 3 },
  { name: '6/8 (90)', bpm: 90, num: 6, den: 8, sub: 1 },
];

// --- Program data + labels ---
//
// A program is an ordered list of blocks. Each block:
//   type:        'warmup'|'rudiment'|'coordination'|'song'|'cooldown' (for icon/label)
//   title:       short heading shown in the runner
//   duration:    seconds — countdown for auto-timed blocks; suggested for userPaced
//   userPaced:   true → "Готово, дальше" button instead of countdown
//   bpm:         starting tempo
//   bpmRamp:     optional { to, step, every } — drives the existing Speed Trainer
//   sig:         { num, den }
//   sub:         1=♩ 2=♫ 3=♪³ 4=♬
//   exercise.kind:
//     'sticking' → exercise.pattern (e.g. 'RLRR LRLL') rendered big
//     'groove'   → exercise.grid { hat:[…], snare:[…], kick:[…] } 0|1 cells
//     'free'     → no exercise visual, only notes
//   exercise.reference: optional "В стиле X (Y), Z (W)" — songs are referenced
//                       by name as cultural pointers; patterns themselves are
//                       generic basics, not transcriptions. Audio/lyrics never.
//   exercise.notes: short instruction shown under the exercise
const PROGRAMS = [
  // === Beginner ===
  {
    id: 'beginner-15', name: 'Начальный · 15 мин', difficulty: 'beginner', duration: 15,
    blocks: [
      { type: 'warmup', title: 'Разминка · одиночные', duration: 120,
        bpm: 60, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L  R L R L',
          notes: 'Восьмыми. Ровность и одинаковая громкость важнее темпа. Слабая рука не отстаёт.' } },
      { type: 'rudiment', title: 'Paradiddle', duration: 240,
        bpm: 70, bpmRamp: { to: 80, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R   L R L L',
          notes: 'Темп растёт сам каждые 4 такта. Чисто > быстро.' } },
      { type: 'coordination', title: 'Базовый рок-бит', duration: 240,
        bpm: 75, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          notes: 'Хэт восьмыми, снейр на 2 и 4, бочка на 1 и 3. Минимум 8 тактов без сбоев.' } },
      { type: 'song', title: 'Песня · в стиле Yellow', duration: 240, userPaced: true,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Yellow (Coldplay) · ≈ 87 BPM',
          notes: 'Сначала чисто на 80 BPM. Когда играешь без сбоев 8 тактов — добавь 5 BPM, и так до 87.' } },
      { type: 'cooldown', title: 'Заминка', duration: 60,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Сыграй то, что хочется. Заканчивай на удовольствии, а не на борьбе.' } },
    ],
  },
  {
    id: 'beginner-30', name: 'Начальный · 30 мин', difficulty: 'beginner', duration: 30,
    description: 'Обе песни идут на одном базовом рок-битe — это тренировка удержания грува при росте темпа: ≈87 → ≈124 BPM.',
    blocks: [
      { type: 'warmup', title: 'Разминка · одиночные', duration: 120,
        bpm: 60, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L  R L R L',
          notes: 'Восьмыми. Ровность важнее громкости.' } },
      { type: 'warmup', title: 'Разминка · двойки', duration: 120,
        bpm: 60, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R R L L  R R L L',
          notes: 'Двойки восьмыми. Второй удар выжимай отскоком, не вторым взмахом.' } },
      { type: 'rudiment', title: 'Single Stroke Roll', duration: 240,
        bpm: 70, bpmRamp: { to: 85, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L  R L R L',
          notes: 'Темп растёт автоматически. Останавливайся, если громкость поплыла.' } },
      { type: 'rudiment', title: 'Paradiddle', duration: 240,
        bpm: 70, bpmRamp: { to: 80, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R   L R L L',
          notes: 'Чисто > быстро. На максимуме 1 минута без сбоев — задача дня.' } },
      { type: 'coordination', title: 'Базовый рок-бит', duration: 210,
        bpm: 75, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          notes: 'Хэт восьмыми, снейр 2 и 4, бочка 1 и 3.' } },
      { type: 'coordination', title: 'Усложнение · бочка на «1 и»', duration: 210,
        bpm: 75, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,1,0,0,1,0,0,0] },
          notes: 'То же, но добавь бочку сразу после первой доли (на «и»).' } },
      { type: 'song', title: 'Песня · в стиле Yellow', duration: 240, userPaced: true,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Yellow (Coldplay) · ≈ 87 BPM',
          notes: 'Чисто на 80 → +5 BPM → +5 BPM. Не разгоняйся, пока есть сбои.' } },
      { type: 'song', title: 'Песня · в стиле Seven Nation Army', duration: 240, userPaced: true,
        bpm: 105, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Seven Nation Army (The White Stripes) · ≈ 124 BPM',
          notes: 'Тот же рисунок, но быстрее и жёстче. Стартуй с 105, целевой темп — 124.' } },
      { type: 'cooldown', title: 'Заминка', duration: 180,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Сыграй любимый трек или просто что хочется.' } },
    ],
  },
  {
    id: 'beginner-60', name: 'Начальный · 60 мин', difficulty: 'beginner', duration: 60,
    description: 'Все три песни идут на одном базовом рок-битe — фокус на удержании грува при росте темпа: ≈87 → ≈110 → ≈124 BPM.',
    blocks: [
      { type: 'warmup', title: 'Разминка · одиночные', duration: 180,
        bpm: 60, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L  R L R L', notes: 'Восьмыми. Ровность.' } },
      { type: 'warmup', title: 'Разминка · двойки', duration: 180,
        bpm: 65, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R R L L  R R L L', notes: 'Используй отскок для второго удара.' } },
      { type: 'warmup', title: 'Разминка · 8 на руку', duration: 120,
        bpm: 70, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: '8R · 8L · 4R · 4L · 2R · 2L · RL',
          notes: 'Пирамида: 8 правой → 8 левой → 4/4 → 2/2 → одиночные.' } },
      { type: 'rudiment', title: 'Single Stroke Roll', duration: 300,
        bpm: 70, bpmRamp: { to: 85, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L  R L R L', notes: 'Темп растёт сам.' } },
      { type: 'rudiment', title: 'Double Stroke Roll', duration: 300,
        bpm: 70, bpmRamp: { to: 85, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R R L L  R R L L', notes: 'Двойки. Чисто > быстро.' } },
      { type: 'rudiment', title: 'Paradiddle', duration: 300,
        bpm: 70, bpmRamp: { to: 85, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R   L R L L', notes: 'Парадиддл.' } },
      { type: 'coordination', title: 'Рок-бит · вариант 1', duration: 180,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          notes: 'Базовый: бочка на 1 и 3.' } },
      { type: 'coordination', title: 'Рок-бит · вариант 2', duration: 180,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,1,0,0,1,0,0,0] },
          notes: 'Бочка на 1, «1 и», 3.' } },
      { type: 'coordination', title: 'Рок-бит · вариант 3', duration: 180,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,1,0] },
          notes: 'Бочка на 1, 3, «3 и».' } },
      { type: 'coordination', title: 'Рок-бит · хэт шестнадцатыми', duration: 180,
        bpm: 75, sig: { num: 4, den: 4 }, sub: 4,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0] },
          notes: 'То же, но хэт шестнадцатыми. Темп ниже — рука должна успевать.' } },
      { type: 'song', title: 'Песня · в стиле Yellow', duration: 420, userPaced: true,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Yellow (Coldplay) · ≈ 87 BPM',
          notes: 'Чисто на 80 → +5 → +5. Не торопись.' } },
      { type: 'song', title: 'Песня · в стиле With or Without You', duration: 420, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле With or Without You (U2) · ≈ 110 BPM',
          notes: 'Тот же базовый рисунок, чуть быстрее. Целься в 110.' } },
      { type: 'song', title: 'Песня · в стиле Seven Nation Army', duration: 420, userPaced: true,
        bpm: 110, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Seven Nation Army (The White Stripes) · ≈ 124 BPM',
          notes: 'Тот же рисунок, целевой темп — 124. Жёсткий бэкбит на снейре, сохраняй ровность.' } },
      { type: 'cooldown', title: 'Заминка', duration: 300,
        bpm: 80, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободная игра под любимую музыку. Без метронома, если хочешь.' } },
    ],
  },

  // === Intermediate ===
  {
    id: 'intermediate-15', name: 'Средний · 15 мин', difficulty: 'intermediate', duration: 15,
    blocks: [
      { type: 'warmup', title: 'Разминка', duration: 120,
        bpm: 70, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L · R R L L',
          notes: '1 минута одиночными, 1 минута двойками. Запястье свободно.' } },
      { type: 'rudiment', title: 'Double Stroke Roll', duration: 180,
        bpm: 80, bpmRamp: { to: 100, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R R L L  R R L L',
          notes: 'Второй удар выжимай пальцами. Не маши запястьем дважды.' } },
      { type: 'coordination', title: 'Бочка четвертями', duration: 240,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,1,0,1,0,1,0] },
          notes: 'Бочка на каждую четверть. Развивает выносливость на ноге.' } },
      { type: 'song', title: 'Песня · в стиле Smells Like Teen Spirit', duration: 300, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Smells Like Teen Spirit (Nirvana), куплет · ≈ 117 BPM',
          notes: 'Базовый рисунок куплета. Стартуй на 100, целевой 117.' } },
      { type: 'cooldown', title: 'Заминка', duration: 60,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободно.' } },
    ],
  },
  {
    id: 'intermediate-30', name: 'Средний · 30 мин', difficulty: 'intermediate', duration: 30,
    blocks: [
      { type: 'warmup', title: 'Разминка', duration: 240,
        bpm: 75, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L · R R L L · R L R R  L R L L',
          notes: 'Первая минута — одиночные, вторая — двойки, последние две — парадиддл.' } },
      { type: 'rudiment', title: 'Double Stroke Roll', duration: 180,
        bpm: 80, bpmRamp: { to: 100, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R R L L  R R L L', notes: 'Двойки. Темп растёт сам.' } },
      { type: 'rudiment', title: 'Paradiddle вариации', duration: 300,
        bpm: 85, bpmRamp: { to: 100, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R   L R L L',
          notes: 'Сначала прямой парадиддл. Потом обратный: L R L L · R L R R. Чередуй каждые 8 тактов.' } },
      { type: 'coordination', title: 'Half-time бит', duration: 360,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,0,0] },
          notes: 'Снейр только на 3 — сильно меняет ощущение. Бочка на 1.' } },
      { type: 'song', title: 'Песня · в стиле Back in Black', duration: 300, userPaced: true,
        bpm: 85, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,1,1,0,0,0] },
          reference: 'В стиле Back in Black (AC/DC) · ≈ 96 BPM',
          notes: 'Синкопа на бочке (1 и «2 и»). Стартуй с 85, целевой 96.' } },
      { type: 'song', title: 'Песня · в стиле Smells Like Teen Spirit', duration: 300, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Smells Like Teen Spirit (Nirvana), куплет · ≈ 117 BPM',
          notes: 'Целевой темп 117.' } },
      { type: 'cooldown', title: 'Заминка', duration: 120,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободно.' } },
    ],
  },
  {
    id: 'intermediate-60', name: 'Средний · 60 мин', difficulty: 'intermediate', duration: 60,
    blocks: [
      { type: 'warmup', title: 'Разминка', duration: 420,
        bpm: 75, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R L · R R L L · R L R R  L R L L · 8R 8L 4/4 2/2',
          notes: '~2 мин одиночные → ~2 мин двойки → ~2 мин парадиддл → ~1 мин пирамида.' } },
      { type: 'rudiment', title: 'Double Stroke Roll', duration: 420,
        bpm: 80, bpmRamp: { to: 105, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R R L L  R R L L', notes: 'Длинный прогон. Не разгоняйся раньше времени.' } },
      { type: 'rudiment', title: 'Paradiddle вариации', duration: 420,
        bpm: 85, bpmRamp: { to: 105, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R   L R L L',
          notes: 'Каждые 8 тактов меняй: прямой → обратный (L R L L · R L R R) → флэм-парадиддл.' } },
      { type: 'coordination', title: 'Half-time бит', duration: 360,
        bpm: 95, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,0,0] },
          notes: 'Снейр на 3.' } },
      { type: 'coordination', title: 'Шаффл', duration: 420,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 3,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          notes: 'Деления — триоли. Хэт играет 1-ю и 3-ю триоль каждой доли (1 — 3 1 — 3). Снейр 2 и 4.' } },
      { type: 'song', title: 'Песня · в стиле Back in Black', duration: 420, userPaced: true,
        bpm: 85, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,1,1,0,0,0] },
          reference: 'В стиле Back in Black (AC/DC) · ≈ 96 BPM',
          notes: 'Целевой 96.' } },
      { type: 'song', title: 'Песня · в стиле Smells Like Teen Spirit', duration: 420, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Smells Like Teen Spirit (Nirvana) · ≈ 117 BPM', notes: 'Целевой 117.' } },
      { type: 'song', title: 'Песня · в стиле Seven Nation Army', duration: 420, userPaced: true,
        bpm: 115, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [0,0,1,0,0,0,1,0], kick: [1,0,0,0,1,0,0,0] },
          reference: 'В стиле Seven Nation Army (The White Stripes) · ≈ 124 BPM', notes: 'Целевой 124.' } },
      { type: 'cooldown', title: 'Заминка', duration: 300,
        bpm: 95, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободная игра.' } },
    ],
  },

  // === Advanced ===
  {
    id: 'advanced-15', name: 'Профи · 15 мин', difficulty: 'advanced', duration: 15,
    blocks: [
      { type: 'warmup', title: 'Разминка', duration: 120,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R   L R L L · 8R 8L 4/4 2/2',
          notes: '1 минута парадиддл, 1 минута пирамида. Запястье свободно.' } },
      { type: 'rudiment', title: 'Flam Tap', duration: 180,
        bpm: 90, bpmRamp: { to: 105, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'lR R · rL L · lR R · rL L',
          notes: 'Маленькая буква — флэм (грейс-нота другой рукой). Большая — основной удар.' } },
      { type: 'coordination', title: 'Линейный паттерн + хэт ногой', duration: 240,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,0,1,0,1,0,1,0], snare: [0,1,0,0,0,1,0,0], kick: [0,0,0,1,0,0,0,1] },
          notes: 'Линейка: только один голос за раз. Дополнительно — хэт ногой на 2 и 4 (в сетке не показано).' } },
      { type: 'song', title: 'Песня · в стиле Billie Jean', duration: 300, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 4,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0] },
          reference: 'В стиле Billie Jean (Michael Jackson) · ≈ 117 BPM',
          notes: 'Шестнадцатые на хэте. Снейр 2 и 4, бочка 1 и 3. Целевой 117.' } },
      { type: 'cooldown', title: 'Заминка', duration: 60,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободно.' } },
    ],
  },
  {
    id: 'advanced-30', name: 'Профи · 30 мин', difficulty: 'advanced', duration: 30,
    blocks: [
      { type: 'warmup', title: 'Разминка', duration: 240,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R  L R L L · lR R  rL L',
          notes: '2 мин парадиддл, 2 мин flam tap.' } },
      { type: 'rudiment', title: 'Flam Tap + 6-stroke roll', duration: 420,
        bpm: 90, bpmRamp: { to: 110, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'lR R  rL L  ·  R LL RR L',
          notes: 'Каждые 8 тактов меняй между flam tap и 6-stroke roll (RLLRRL).' } },
      { type: 'coordination', title: 'Линейный + хэт ногой 2,4', duration: 240,
        bpm: 95, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,0,1,0,1,0,1,0], snare: [0,1,0,0,0,1,0,0], kick: [0,0,0,1,0,0,0,1] },
          notes: 'Линейный паттерн на руках, хэт ногой на 2 и 4 (в сетке не показано).' } },
      { type: 'coordination', title: 'Джазовое остинато', duration: 240,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 3,
        exercise: { kind: 'free',
          notes: 'Ride: «1 — 2 и а 3 — 4 и а» (триолями). Хэт ногой на 2 и 4. Бочка тихо «фидером» на 1 и 3. Малый — соло по Stick Control.' } },
      { type: 'song', title: 'Песня · в стиле Billie Jean', duration: 300, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 4,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0] },
          reference: 'В стиле Billie Jean (Michael Jackson) · ≈ 117 BPM',
          notes: '16-е на хэте, ровно. Целевой 117.' } },
      { type: 'song', title: 'Песня · в стиле Sunday Bloody Sunday', duration: 240, userPaced: true,
        bpm: 95, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [1,0,1,0,1,0,1,0], kick: [1,0,0,0,0,0,1,0] },
          reference: 'В стиле Sunday Bloody Sunday (U2) · ≈ 102 BPM',
          notes: 'Маршевый снейр на каждой четверти. Целевой 102.' } },
      { type: 'cooldown', title: 'Заминка', duration: 120,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободно.' } },
    ],
  },
  {
    id: 'advanced-60', name: 'Профи · 60 мин', difficulty: 'advanced', duration: 60,
    blocks: [
      { type: 'warmup', title: 'Разминка', duration: 420,
        bpm: 85, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'R L R R  L R L L · lR R  rL L · R LL RR L · 8R 8L 4/4',
          notes: '~2 мин парадиддл → ~2 мин flam tap → ~2 мин 6-stroke roll → ~1 мин пирамида.' } },
      { type: 'rudiment', title: 'Flam Tap', duration: 480,
        bpm: 90, bpmRamp: { to: 110, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'sticking', pattern: 'lR R   rL L', notes: 'Длинный прогон. Темп растёт сам.' } },
      { type: 'rudiment', title: '6-stroke roll', duration: 480,
        bpm: 100, bpmRamp: { to: 120, step: 5, every: 4 }, sig: { num: 4, den: 4 }, sub: 3,
        exercise: { kind: 'sticking', pattern: 'R LL RR L  ·  R LL RR L',
          notes: 'Деления — триоли. Акценты на одиночные, двойки тише.' } },
      { type: 'coordination', title: 'Линейный + хэт ногой 2,4', duration: 420,
        bpm: 95, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,0,1,0,1,0,1,0], snare: [0,1,0,0,0,1,0,0], kick: [0,0,0,1,0,0,0,1] },
          notes: 'Хэт ногой на 2 и 4 (в сетке не показано).' } },
      { type: 'coordination', title: 'Джазовое остинато', duration: 420,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 3,
        exercise: { kind: 'free',
          notes: 'Ride: «1 — 2 и а 3 — 4 и а». Хэт ногой 2 и 4. Малый — соло по Stick Control.' } },
      { type: 'song', title: 'Песня · в стиле Billie Jean', duration: 360, userPaced: true,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 4,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0] },
          reference: 'В стиле Billie Jean (Michael Jackson) · ≈ 117 BPM', notes: 'Целевой 117.' } },
      { type: 'song', title: 'Песня · в стиле Sunday Bloody Sunday', duration: 360, userPaced: true,
        bpm: 95, sig: { num: 4, den: 4 }, sub: 2,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1], snare: [1,0,1,0,1,0,1,0], kick: [1,0,0,0,0,0,1,0] },
          reference: 'В стиле Sunday Bloody Sunday (U2) · ≈ 102 BPM', notes: 'Целевой 102.' } },
      { type: 'song', title: 'Фанк с гост-нотами', duration: 360, userPaced: true,
        bpm: 90, sig: { num: 4, den: 4 }, sub: 4,
        exercise: { kind: 'groove',
          grid: { hat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], kick: [1,0,0,0,0,0,1,0,0,1,0,0,0,0,0,0] },
          notes: 'Базовый фанк-грув с гост-нотами на снейре между основными ударами. Гост-ноты тихо, акцент на 2 и 4.' } },
      { type: 'cooldown', title: 'Заминка', duration: 300,
        bpm: 100, sig: { num: 4, den: 4 }, sub: 1,
        exercise: { kind: 'free', notes: 'Свободно.' } },
    ],
  },
];

const DIFFICULTY_LABELS = {
  beginner: 'Начальный',
  intermediate: 'Средний',
  advanced: 'Профи',
};

const BLOCK_TYPE_LABELS = {
  warmup: 'Разминка',
  rudiment: 'Рудимент',
  coordination: 'Координация',
  song: 'Песня',
  cooldown: 'Заминка',
};

// --- Theme ---

function loadTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return (t === 'light' || t === 'dark') ? t : 'dark';
  } catch { return 'dark'; }
}

function applyTheme(name) {
  const t = (name === 'light') ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  const meta = document.getElementById('meta-theme-color');
  if (meta) meta.setAttribute('content', THEME_COLORS[t]);
  document.querySelectorAll('#theme-picker .preset').forEach(b => {
    b.classList.toggle('is-active', b.dataset.theme === t);
  });
}

// --- Audio scheduling ---

async function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }

  // iOS silent-switch bypass: a silent <audio> loop puts the audio session
  // into "playback" category, which ignores the physical mute switch.
  // Harmless on Android — just plays inaudible audio in the background.
  if (!silentAudio) {
    silentAudio = new Audio('./silent.mp3');
    silentAudio.loop = true;
    silentAudio.preload = 'auto';
    silentAudio.setAttribute('playsinline', '');
  }
  if (silentAudio.paused) {
    try { await silentAudio.play(); } catch {}
  }
}

function playClick(type, time) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  // Waveform comes from the user's sound choice for accent vs. beat.
  // 'soft' and 'sub' (subdivision tick) follow the beat sound — they're
  // quieter variants of the regular beat, so should share its timbre.
  const accentWave = SOUND_TYPES[state.soundAccent]?.wave || 'square';
  const beatWave   = SOUND_TYPES[state.soundBeat]?.wave   || 'square';

  let freq, vol, dur, wave;
  if (type === 'accent')      { freq = 1500; vol = state.volAccent;       dur = 0.05; wave = accentWave; }
  else if (type === 'beat')   { freq = 900;  vol = state.volBeat;         dur = 0.05; wave = beatWave; }
  else if (type === 'soft')   { freq = 700;  vol = state.volBeat * 0.5;   dur = 0.04; wave = beatWave; }
  else                        { freq = 600;  vol = state.volSub;          dur = 0.03; wave = beatWave; }

  osc.type = wave;
  osc.frequency.value = freq;
  const peak = Math.max(0.0001, vol * state.volMaster);
  gain.gain.setValueAtTime(peak, time);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

  osc.connect(gain).connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + dur + 0.01);
}

function scheduleNote(beat, sub, time) {
  notesInQueue.push({ beat, sub, time });

  // Bar-pattern mute: silence the entire bar (beats + subs) on the
  // skip-portion of each play/skip cycle. muteBarCount advances at bar
  // boundaries in advance().
  if (state.muteEnabled) {
    const total = state.mutePlayBars + state.muteSkipBars;
    if (total > 0 && state.muteBarCount % total >= state.mutePlayBars) return;
  }

  if (sub === 0) {
    const beatType = state.beatTypes[beat] || 'beat';
    if (beatType === 'mute') return;
    playClick(beatType, time);
  } else {
    playClick('sub', time);
  }
}

function advance() {
  const secondsPerBeat = 60.0 / state.bpm;
  nextNoteTime += secondsPerBeat / state.subdivision;

  state.currentSub++;
  if (state.currentSub >= state.subdivision) {
    state.currentSub = 0;
    state.currentBeat++;
    if (state.currentBeat >= state.beatsPerMeasure) {
      state.currentBeat = 0;
      state.muteBarCount++;
      if (state.trainerEnabled) {
        state.trainerBarCount++;
        if (state.trainerBarCount >= state.trainerBars) {
          state.trainerBarCount = 0;
          const next = state.bpm + state.trainerStep;
          if (next <= state.trainerEnd) setBpm(next);
        }
      }
    }
  }
}

function scheduler() {
  while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) {
    scheduleNote(state.currentBeat, state.currentSub, nextNoteTime);
    advance();
  }
  timerID = setTimeout(scheduler, LOOKAHEAD_MS);
}

async function start() {
  await ensureAudio();
  if (audioCtx.state !== 'running') {
    showToast('Не удалось включить звук. Проверь громкость и переключатель silent.');
    return;
  }
  detectBtLatency();
  if (state.trainerEnabled) setBpm(state.trainerStart);
  state.isPlaying = true;
  state.currentBeat = 0;
  state.currentSub = 0;
  state.trainerBarCount = 0;
  state.muteBarCount = 0;
  // Count-in: just push the first scheduled note out by countinSec seconds
  // so the metronome stays silent during the countdown. Scheduler runs
  // normally — it just won't queue anything until we get within the
  // SCHEDULE_AHEAD window of nextNoteTime.
  const delaySec = state.countinSec > 0 ? state.countinSec : 0;
  nextNoteTime = audioCtx.currentTime + delaySec + 0.05;
  scheduler();
  requestAnimationFrame(draw);
  updatePlayButton();
  requestWakeLock();
  if (delaySec > 0 && !state.countinActive) {
    runCountdownOverlay(delaySec);
  }
}

function stop() {
  state.isPlaying = false;
  clearTimeout(timerID);
  notesInQueue.length = 0;
  recentBeats.length = 0;
  clearBeatIndicator();
  updatePlayButton();
  releaseWakeLock();
  if (state.countinActive) cancelCountin();
}

function toggle() {
  if (state.isPlaying) stop(); else start();
}

// --- Visual sync ---

// Buffer of beats that have already played, used by mic onset matching to find
// the nearest beat for late hits (notesInQueue only contains upcoming beats).
const recentBeats = [];
const RECENT_BEATS_WINDOW_SEC = 1.0;

function draw() {
  if (!state.isPlaying) return;
  const now = audioCtx.currentTime;
  // Delay visual flash by btLatencyMs so it lines up with what the listener
  // actually hears through their (potentially Bluetooth) headphones.
  const visualOffset = state.btLatencyMs / 1000;
  while (notesInQueue.length && notesInQueue[0].time + visualOffset <= now) {
    const n = notesInQueue.shift();
    if (n.sub === 0) {
      highlightBeat(n.beat);
      recentBeats.push(n);
    }
  }
  // Trim recent beats older than the matching window
  while (recentBeats.length && recentBeats[0].time < now - RECENT_BEATS_WINDOW_SEC) {
    recentBeats.shift();
  }
  requestAnimationFrame(draw);
}

function highlightBeat(beat) {
  // Match by data-beat (not by NodeList index): with a second indicator in
  // the fullscreen view, both share the same beat numbers but live in
  // different parents. Multiple .beat-stack[data-beat="0"] should all light up.
  // Lamp mode (when on) is handled purely in CSS via .lamp-on on the
  // fullscreen container — no JS coordination needed here.
  document.querySelectorAll('.beat-stack').forEach(s => {
    s.classList.toggle('active', Number(s.dataset.beat) === beat);
  });
}

function clearBeatIndicator() {
  document.querySelectorAll('.beat-stack').forEach(s => s.classList.remove('active'));
}

const BEAT_CYCLE = ['accent', 'beat', 'soft', 'mute'];

function rebuildBeatIndicator() {
  // Resize beatTypes preserving existing values
  while (state.beatTypes.length < state.beatsPerMeasure) {
    state.beatTypes.push('beat');
  }
  state.beatTypes.length = state.beatsPerMeasure;

  renderBeatStacks('beat-indicator');
  renderBeatStacks('flash-beat-indicator');
  renderBeatStacks('runner-beat-indicator');
}

function renderBeatStacks(targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  el.innerHTML = '';
  for (let i = 0; i < state.beatsPerMeasure; i++) {
    const stack = document.createElement('button');
    stack.className = 'beat-stack';
    stack.dataset.beat = i;
    stack.dataset.type = state.beatTypes[i];
    stack.setAttribute('aria-label', `Доля ${i + 1}: ${state.beatTypes[i]}`);
    stack.innerHTML = '<span class="bdot"></span><span class="bdot"></span><span class="bdot"></span>';
    stack.addEventListener('click', () => cycleBeat(i));
    el.appendChild(stack);
  }
}

function cycleBeat(i) {
  const current = state.beatTypes[i];
  const idx = BEAT_CYCLE.indexOf(current);
  const next = BEAT_CYCLE[(idx + 1) % BEAT_CYCLE.length];
  state.beatTypes[i] = next;
  // Update every instance of this beat across both indicators
  document.querySelectorAll(`.beat-stack[data-beat="${i}"]`).forEach(stack => {
    stack.dataset.type = next;
    stack.setAttribute('aria-label', `Доля ${i + 1}: ${next}`);
  });
}

// --- Display updaters ---

// --- BPM wheel ---

const BPM_MIN = 30;
const BPM_MAX = 320;
const TICK_PX = 10;  // tick (2px) + gap (8px) per BPM step
// Easter-egg image fades in over the 300→320 BPM range (opacity 0→1).
// Image is positioned absolutely over the BPM/wheel area and never moves.
const EASTER_START_BPM = 300;
let suppressWheelScroll = false;

function buildBpmWheel() {
  const track = $('wheel-track');
  track.innerHTML = '';
  for (let bpm = BPM_MIN; bpm <= BPM_MAX; bpm++) {
    const tick = document.createElement('div');
    tick.className = 'wheel-tick';
    tick.dataset.bpm = bpm;
    track.appendChild(tick);
  }
  // Trailing flex spacer so the last tick can reach the wheel's center.
  // Safari's flex scroll containers don't always count padding-right into
  // scrollWidth, but a real flex child with explicit width is. Width is
  // set in applyWheelPadding (= halfW). All three sizing properties are
  // sent because Safari has been observed to ignore one or the other for
  // empty flex children.
  const spacer = document.createElement('div');
  spacer.className = 'wheel-spacer';
  track.appendChild(spacer);
  applyWheelPadding();
  scrollWheelToBpm(state.bpm, false);
}

function applyWheelPadding() {
  const wheel = $('bpm-wheel');
  const track = $('wheel-track');
  const halfW = wheel.clientWidth / 2;
  // padding-left so the first tick can reach the center; the trailing
  // edge uses a flex spacer instead of padding-right (see buildBpmWheel).
  track.style.paddingLeft = halfW + 'px';
  track.style.paddingRight = '0';
  const spacer = track.querySelector('.wheel-spacer');
  if (spacer) {
    spacer.style.width = `${halfW}px`;
    spacer.style.minWidth = `${halfW}px`;
    spacer.style.flex = `0 0 ${halfW}px`;
  }
}

function easterProgress() {
  // Fade Arnold in over the 300→320 BPM range based on state.bpm.
  const range = BPM_MAX - EASTER_START_BPM;
  if (range <= 0) return 0;
  return Math.max(0, Math.min(1, (state.bpm - EASTER_START_BPM) / range));
}

function updateEaster() {
  const easter = $('bpm-easter');
  if (!easter) return;
  easter.style.opacity = String(easterProgress());
}

function scrollWheelToBpm(bpm, smooth = true) {
  const wheel = $('bpm-wheel');
  if (!wheel) return;
  const target = (bpm - BPM_MIN) * TICK_PX;
  suppressWheelScroll = true;
  wheel.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
  // release after scroll settles
  setTimeout(() => { suppressWheelScroll = false; }, smooth ? 350 : 50);
}

let scrollEndTimer = null;

function onWheelScroll() {
  if (suppressWheelScroll) return;
  // Lazy-create AudioContext on first scroll so the wheel-tick can play
  // (scroll/touch counts as a user gesture for resume()).
  if (!audioCtx) ensureAudio();
  const wheel = $('bpm-wheel');
  const idx = Math.round(wheel.scrollLeft / TICK_PX);
  const bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, BPM_MIN + idx));
  if (bpm !== state.bpm) {
    state.bpm = bpm;
    $('bpm-input').value = bpm;
    wheel.setAttribute('aria-valuenow', String(bpm));
    playWheelTick();
  }
  updateEaster();
  // After scroll settles, snap scrollLeft to the nearest BPM tick.
  clearTimeout(scrollEndTimer);
  scrollEndTimer = setTimeout(() => {
    if (suppressWheelScroll) return;
    const targetLeft = (state.bpm - BPM_MIN) * TICK_PX;
    if (Math.abs(wheel.scrollLeft - targetLeft) > 1) {
      scrollWheelToBpm(state.bpm, true);
    }
  }, 140);
}

function setBpm(v) {
  v = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v)));
  state.bpm = v;
  $('bpm-input').value = v;
  const flashBpm = $('flash-bpm');
  if (flashBpm) flashBpm.textContent = v;
  const wheel = $('bpm-wheel');
  if (wheel) {
    wheel.setAttribute('aria-valuenow', String(v));
    scrollWheelToBpm(v, true);
  }
  updateEaster();
}

// --- Wheel tick (haptic + soft click on BPM scroll) ---
//
// Throttle to ~30 ticks/sec max — onscroll can fire faster than that on
// fast swipes, and stacking too many tiny envelopes muddies the audio.
let lastWheelTickTime = 0;
const WHEEL_TICK_MIN_INTERVAL = 0.03;

function playWheelTick() {
  // Haptic first — works on Android Chrome, no-op on iOS Safari (Apple
  // hasn't implemented Vibration API in mobile Safari).
  try { navigator.vibrate?.(8); } catch {}

  if (!audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  if (now - lastWheelTickTime < WHEEL_TICK_MIN_INTERVAL) return;
  lastWheelTickTime = now;

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = 200;  // low → reads as a soft "thump"
  const peak = 0.06 * state.volMaster;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), now + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.03);
}

// --- Sound profile picker ---

async function applySoundChoice(beatType, soundKey) {
  if (!SOUND_TYPES[soundKey]) return;
  if (beatType === 'accent') {
    state.soundAccent = soundKey;
    try { localStorage.setItem(SOUND_ACCENT_KEY, soundKey); } catch {}
  } else {
    state.soundBeat = soundKey;
    try { localStorage.setItem(SOUND_BEAT_KEY, soundKey); } catch {}
  }
  updateSoundPickerUI();
  // Preview the new sound at current volumes
  await ensureAudio();
  if (audioCtx?.state === 'running') {
    playClick(beatType, audioCtx.currentTime + 0.01);
  }
}

function updateSoundPickerUI() {
  document.querySelectorAll('#sound-accent-picker .preset').forEach(b => {
    b.classList.toggle('is-active', b.dataset.sound === state.soundAccent);
  });
  document.querySelectorAll('#sound-beat-picker .preset').forEach(b => {
    b.classList.toggle('is-active', b.dataset.sound === state.soundBeat);
  });
}

function updateSubDisplay() {
  const meta = SUB_META[state.subdivision];
  $('sub-symbol').textContent = meta.symbol;
  $('sub-label').textContent = meta.label;
  const flashSub = $('flash-sub');
  if (flashSub) flashSub.textContent = meta.symbol;
  document.querySelectorAll('.sub-option').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.sub) === state.subdivision);
  });
}

function updateTimeDisplay() {
  $('time-num-out').textContent = state.beatsPerMeasure;
  $('time-den-out').textContent = state.beatUnit;
  const flashSig = $('flash-timesig');
  if (flashSig) flashSig.textContent = `${state.beatsPerMeasure}/${state.beatUnit}`;
  document.querySelectorAll('#time-grid button').forEach(b => {
    const n = Number(b.dataset.num);
    const d = Number(b.dataset.den);
    if (!Number.isNaN(n)) b.classList.toggle('active', n === state.beatsPerMeasure);
    if (!Number.isNaN(d)) b.classList.toggle('active', d === state.beatUnit);
  });
}

function updatePlayButton() {
  const btn = $('play-btn');
  btn.classList.toggle('playing', state.isPlaying);
  btn.querySelector('.play-icon').textContent = state.isPlaying ? '■' : '▶';
  btn.querySelector('.play-text').textContent = state.isPlaying ? 'СТОП' : 'СТАРТ';
  // Allow re-arming the count-in even while the metronome plays — it
  // just affects the next start. Lock only while a countdown is running.
  const cin = $('countin-btn');
  if (cin) cin.disabled = state.countinActive;
  // Sync the in-fullscreen Start/Stop button (icon-only)
  const flashPlay = $('flash-play');
  if (flashPlay) {
    flashPlay.classList.toggle('playing', state.isPlaying);
    flashPlay.querySelector('.flash-play-icon').textContent = state.isPlaying ? '■' : '▶';
  }
  // Sync the program runner's Start/Stop button
  const runnerPlay = $('runner-play');
  if (runnerPlay) {
    runnerPlay.classList.toggle('playing', state.isPlaying);
    runnerPlay.querySelector('.runner-play-icon').textContent = state.isPlaying ? '■' : '▶';
  }
}

// --- Tap tempo ---

const tapTimes = [];
function tap() {
  const now = performance.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2000) {
    tapTimes.length = 0;
  }
  tapTimes.push(now);
  if (tapTimes.length > 5) tapTimes.shift();
  if (tapTimes.length >= 2) {
    const intervals = [];
    for (let i = 1; i < tapTimes.length; i++) intervals.push(tapTimes[i] - tapTimes[i - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    setBpm(60000 / avg);
  }
  const btn = $('tap-btn');
  btn.classList.remove('pulse');
  void btn.offsetWidth;
  btn.classList.add('pulse');
}

// --- Presets ---

const PRESETS_KEY = 'metronome.user-presets.v1';

function applyPreset(p, sig = null) {
  setBpm(p.bpm);
  state.beatsPerMeasure = p.num;
  state.beatUnit = p.den;
  state.subdivision = p.sub;
  state.currentBeat = 0;
  state.currentSub = 0;
  state.activePresetSig = sig;
  rebuildBeatIndicator();
  updateSubDisplay();
  updateTimeDisplay();
  updateActivePresetUI();
}

function updateActivePresetUI() {
  document.querySelectorAll('.preset[data-preset-sig]').forEach(b => {
    b.classList.toggle('is-active', b.dataset.presetSig === state.activePresetSig);
  });
}

function checkActivePresetStillMatches() {
  if (!state.activePresetSig) return;
  const [type, idxStr] = state.activePresetSig.split(':');
  const idx = Number(idxStr);
  let p = null;
  if (type === 'builtin') p = BUILTIN_PRESETS[idx];
  else if (type === 'user') p = loadUserPresets()[idx];
  const matches = p
    && state.bpm === p.bpm
    && state.beatsPerMeasure === p.num
    && state.beatUnit === p.den
    && state.subdivision === p.sub;
  if (!matches) {
    state.activePresetSig = null;
    updateActivePresetUI();
  }
}

function renderBuiltinPresets() {
  const root = $('builtin-presets');
  root.innerHTML = '';
  BUILTIN_PRESETS.forEach((p, idx) => {
    const sig = `builtin:${idx}`;
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.presetSig = sig;
    b.textContent = p.name;
    b.addEventListener('click', () => { applyPreset(p, sig); closeModal('presets-modal'); });
    root.appendChild(b);
  });
  updateActivePresetUI();
}

function loadUserPresets() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY)) || []; }
  catch { return []; }
}

function saveUserPresets(list) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(list));
}

function renderUserPresets() {
  const root = $('user-presets');
  root.innerHTML = '';
  const list = loadUserPresets();
  if (!list.length) {
    root.innerHTML = '<p class="muted small">Свои пресеты появятся здесь.</p>';
    return;
  }
  list.forEach((p, idx) => {
    const sig = `user:${idx}`;
    const wrap = document.createElement('div');
    wrap.className = 'preset-row';
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.presetSig = sig;
    b.textContent = `${p.name} · ${p.bpm} BPM`;
    b.addEventListener('click', () => { applyPreset(p, sig); closeModal('presets-modal'); });
    const del = document.createElement('button');
    del.className = 'preset-del';
    del.textContent = '✕';
    del.title = 'Удалить пресет';
    del.addEventListener('click', () => {
      const list2 = loadUserPresets();
      list2.splice(idx, 1);
      saveUserPresets(list2);
      // User-preset indices may shift after deletion — drop selection if it pointed here
      if (state.activePresetSig?.startsWith('user:')) state.activePresetSig = null;
      renderUserPresets();
    });
    wrap.append(b, del);
    root.appendChild(wrap);
  });
  updateActivePresetUI();
}

function saveCurrentAsPreset() {
  const name = $('preset-name').value.trim();
  if (!name) { $('preset-name').focus(); return; }
  const list = loadUserPresets();
  list.push({
    name,
    bpm: state.bpm,
    num: state.beatsPerMeasure,
    den: state.beatUnit,
    sub: state.subdivision,
  });
  saveUserPresets(list);
  $('preset-name').value = '';
  renderUserPresets();
}

// --- Tabs + modals ---

const TAB_TITLES = {
  metronome: 'Метроном',
  training: 'Тренировки',
  settings: 'Настройки',
};

function switchTab(tabId) {
  if (!TAB_TITLES[tabId]) return;
  document.querySelectorAll('.tab-view').forEach(v => {
    v.classList.toggle('active', v.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-bar-item').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  $('page-title').textContent = TAB_TITLES[tabId];
  // Re-evaluate active preset highlight when entering Settings
  if (tabId === 'settings') checkActivePresetStillMatches();
}

function openModal(id) {
  $(id).classList.add('open');
  $(id).setAttribute('aria-hidden', 'false');
}

function closeModal(id) {
  $(id).classList.remove('open');
  $(id).setAttribute('aria-hidden', 'true');
}

function buildTimeGrid() {
  const grid = $('time-grid');
  grid.innerHTML = '';

  const labelN = document.createElement('div');
  labelN.className = 'time-section-label';
  labelN.textContent = 'Числитель (доли в такте)';
  grid.appendChild(labelN);

  TIME_NUMERATORS.forEach(n => {
    const b = document.createElement('button');
    b.dataset.num = n;
    b.textContent = n;
    b.addEventListener('click', () => {
      state.beatsPerMeasure = n;
      state.currentBeat = 0;
      rebuildBeatIndicator();
      updateTimeDisplay();
    });
    grid.appendChild(b);
  });

  const labelD = document.createElement('div');
  labelD.className = 'time-section-label';
  labelD.textContent = 'Знаменатель (длительность доли)';
  grid.appendChild(labelD);

  TIME_DENOMINATORS.forEach(d => {
    const b = document.createElement('button');
    b.dataset.den = d;
    b.textContent = `1/${d}`;
    b.addEventListener('click', () => {
      state.beatUnit = d;
      updateTimeDisplay();
    });
    grid.appendChild(b);
  });
}

// --- Bindings ---

function bind() {
  $('bpm-input').addEventListener('change', e => setBpm(Number(e.target.value)));
  document.querySelectorAll('.bpm-step').forEach(b => {
    b.addEventListener('click', () => setBpm(state.bpm + Number(b.dataset.delta)));
  });

  // BPM wheel: native horizontal scroll (touch + trackpad horizontal)
  const wheel = $('bpm-wheel');
  wheel.addEventListener('scroll', onWheelScroll, { passive: true });
  // Resume the AudioContext on first touch/click so the wheel-tick
  // sound works immediately — by the time the first scroll event fires,
  // resume() will have completed. Without this the tick was silent
  // until the user had started+stopped the metronome at least once.
  wheel.addEventListener('pointerdown', () => { ensureAudio(); }, { passive: true });

  // Mouse wheel / trackpad: translate any wheel delta into horizontal scroll
  wheel.addEventListener('wheel', (e) => {
    const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (delta === 0) return;
    e.preventDefault();
    wheel.scrollLeft += delta;
  }, { passive: false });

  // Click-and-drag on desktop. Touch is handled natively.
  let dragStartX = 0;
  let dragStartScroll = 0;
  let dragMoved = false;
  let isDragging = false;
  wheel.addEventListener('mousedown', (e) => {
    e.preventDefault();
    isDragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartScroll = wheel.scrollLeft;
    wheel.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    if (Math.abs(dx) > 2) dragMoved = true;
    wheel.scrollLeft = dragStartScroll - dx;
  });
  window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    wheel.classList.remove('dragging');
    // Click without drag: jump wheel to clicked position
    if (!dragMoved) {
      const rect = wheel.getBoundingClientRect();
      const offsetFromCenter = e.clientX - (rect.left + rect.width / 2);
      wheel.scrollTo({ left: wheel.scrollLeft + offsetFromCenter, behavior: 'smooth' });
    }
  });

  // Recompute padding on viewport resize
  window.addEventListener('resize', () => {
    applyWheelPadding();
    scrollWheelToBpm(state.bpm, false);
  });

  $('tap-btn').addEventListener('click', tap);
  $('play-btn').addEventListener('click', toggle);

  // Bottom tab bar
  document.querySelectorAll('.tab-bar-item').forEach(b => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  // Subdivision modal
  $('sub-btn').addEventListener('click', () => openModal('sub-modal'));
  document.querySelectorAll('.sub-option').forEach(btn => {
    btn.addEventListener('click', () => {
      state.subdivision = Number(btn.dataset.sub);
      state.currentSub = 0;
      updateSubDisplay();
      closeModal('sub-modal');
    });
  });

  // Time signature modal
  $('time-sig-btn').addEventListener('click', () => openModal('time-modal'));

  // Presets modal
  $('presets-btn').addEventListener('click', () => openModal('presets-modal'));

  // Theme picker
  document.querySelectorAll('#theme-picker .preset').forEach(b => {
    b.addEventListener('click', () => applyTheme(b.dataset.theme));
  });

  // Sound profile pickers (one for accent, one for beat)
  document.querySelectorAll('#sound-accent-picker .preset').forEach(b => {
    b.addEventListener('click', () => applySoundChoice('accent', b.dataset.sound));
  });
  document.querySelectorAll('#sound-beat-picker .preset').forEach(b => {
    b.addEventListener('click', () => applySoundChoice('beat', b.dataset.sound));
  });

  // Fullscreen flash view
  $('fullscreen-btn').addEventListener('click', openFlashScreen);
  $('flash-close').addEventListener('click', closeFlashScreen);
  $('flash-lamp').addEventListener('click', toggleLamp);
  $('flash-play').addEventListener('click', toggle);

  // Programs
  $('program-create').addEventListener('click', () => showToast('Эта функция пока не работает'));
  $('program-import').addEventListener('click', openImportModal);
  $('import-paste').addEventListener('click', pasteImportFromClipboard);
  $('import-submit').addEventListener('click', submitImport);
  $('import-confirm-cancel').addEventListener('click', cancelImportConfirm);
  $('import-confirm-save').addEventListener('click', confirmImportSave);
  $('program-difficulty-btn').addEventListener('click', openProgramDifficultySheet);
  $('program-duration-btn').addEventListener('click', openProgramDurationSheet);
  document.querySelectorAll('#program-difficulty-modal .program-picker-option').forEach(b => {
    b.addEventListener('click', () => {
      programPicker.difficulty = b.dataset.difficulty;
      syncProgramPickerUI();
      closeModal('program-difficulty-modal');
    });
  });
  document.querySelectorAll('#program-duration-modal .program-picker-option').forEach(b => {
    b.addEventListener('click', () => {
      programPicker.duration = Number(b.dataset.duration);
      syncProgramPickerUI();
      closeModal('program-duration-modal');
    });
  });
  $('program-next').addEventListener('click', () => {
    if (!programPicker.difficulty && !programPicker.duration) {
      showToast('Выберите сложность и длительность');
      return;
    }
    if (!programPicker.difficulty) { showToast('Выберите сложность'); return; }
    if (!programPicker.duration)   { showToast('Выберите длительность'); return; }
    const p = PROGRAMS.find(x => x.difficulty === programPicker.difficulty && x.duration === programPicker.duration);
    if (p) openProgramPreview(p.id);
  });
  $('program-start').addEventListener('click', () => {
    const id = $('program-start').dataset.programId;
    if (id) startProgram(id);
  });
  $('runner-close').addEventListener('click', attemptCloseRunner);
  $('runner-play').addEventListener('click', () => {
    // If a transition card is up, dismiss it first so user sees the new block
    if ($('runner-transition').classList.contains('open')) hideTransition();
    toggle();
  });
  $('runner-skip').addEventListener('click', userSkipBlock);
  $('runner-extend').addEventListener('click', userExtendBlock);
  $('runner-done').addEventListener('click', userMarkDone);
  $('runner-transition-go').addEventListener('click', hideTransition);
  $('runner-finish-close').addEventListener('click', exitProgram);

  // Rhythm builder
  $('open-rhythm-builder').addEventListener('click', openRhythmEditor);
  $('rhythm-editor-close').addEventListener('click', closeRhythmEditor);
  $('rhythm-presets-btn').addEventListener('click', openRhythmsSheet);
  $('rhythm-clear').addEventListener('click', clearRhythmGrid);
  $('rhythm-mode').addEventListener('click', () => {
    if (rhythmPlayer.active) stopRhythmPlayback();
    toggleRhythmMode();
  });
  $('rhythm-play').addEventListener('click', toggleRhythmPlay);
  $('rhythm-save-btn').addEventListener('click', saveRhythm);
  const adjustRhythmBpm = (delta) => {
    const next = Math.max(30, Math.min(320, (editorState.bpm || 100) + delta));
    editorState.bpm = next;
    $('rhythm-bpm').textContent = next;
  };
  $('rhythm-bpm-up').addEventListener('click', () => adjustRhythmBpm(+1));
  $('rhythm-bpm-down').addEventListener('click', () => adjustRhythmBpm(-1));
  // Mouse wheel / touchpad scroll on the BPM number changes the value.
  // Up scroll = +1, down scroll = -1. preventDefault so the page doesn't
  // also scroll behind the editor.
  $('rhythm-bpm').addEventListener('wheel', e => {
    e.preventDefault();
    adjustRhythmBpm(e.deltaY < 0 ? +1 : -1);
  }, { passive: false });

  // Drag-to-change BPM: press the number and slide finger up (in the
  // user's perceived view) to raise BPM, slide down to lower it. When
  // the editor is rotated for portrait phones, the user-perceived
  // vertical axis is the screen's HORIZONTAL axis, so we read clientX.
  // 5px of finger travel = 1 BPM step.
  let bpmDragStart = null;
  const PIXELS_PER_BPM = 5;
  const isEditorRotated = () => document.body.classList.contains('rhythm-editor-open')
    && window.matchMedia('(orientation: portrait) and (pointer: coarse), (orientation: portrait) and (max-width: 900px)').matches;
  // In rotated mode, finger-up = phone-right = clientX increases. In
  // unrotated mode, finger-up = clientY decreases. Normalize to a
  // single "up = increasing" coordinate.
  const dragCoord = (e) => isEditorRotated() ? e.clientX : -e.clientY;
  $('rhythm-bpm').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    bpmDragStart = { coord: dragCoord(e), bpm: editorState.bpm || 100 };
    e.target.setPointerCapture(e.pointerId);
  });
  $('rhythm-bpm').addEventListener('pointermove', (e) => {
    if (!bpmDragStart) return;
    const delta = dragCoord(e) - bpmDragStart.coord;
    const next = Math.max(30, Math.min(320, bpmDragStart.bpm + Math.round(delta / PIXELS_PER_BPM)));
    if (next !== editorState.bpm) {
      editorState.bpm = next;
      $('rhythm-bpm').textContent = next;
    }
  });
  const endBpmDrag = () => { bpmDragStart = null; };
  $('rhythm-bpm').addEventListener('pointerup', endBpmDrag);
  $('rhythm-bpm').addEventListener('pointercancel', endBpmDrag);
  $('rhythm-save-name').addEventListener('change', e => {
    editorState.name = e.target.value.trim();
  });
  $('rhythm-size-btn').addEventListener('click', openRhythmSizeSheet);
  $('rhythm-division-btn').addEventListener('click', openRhythmDivisionSheet);
  $('rhythm-confirm-cancel').addEventListener('click', () => {
    pendingMeterChange = null;
    closeModal('rhythm-confirm-modal');
  });
  $('rhythm-confirm-ok').addEventListener('click', () => {
    const fn = pendingMeterChange;
    pendingMeterChange = null;
    closeModal('rhythm-confirm-modal');
    if (fn) fn();
  });

  // Count-in (delayed start) — picking arms; the countdown itself fires
  // from start() when the user presses the main Start button.
  $('countin-btn').addEventListener('click', () => {
    if (state.countinActive) return;  // can't change mid-countdown
    openModal('countin-modal');
  });
  document.querySelectorAll('.countin-option').forEach(b => {
    b.addEventListener('click', () => {
      const sec = Number(b.dataset.sec) || 0;
      setCountinSec(sec);
      closeModal('countin-modal');
    });
  });

  // Modal backdrops
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      const modal = el.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });

  // Volumes
  const volMap = [
    ['vol-master', 'volMaster'], ['vol-accent', 'volAccent'],
    ['vol-beat', 'volBeat'], ['vol-sub', 'volSub'],
  ];
  volMap.forEach(([id, key]) => {
    const slider = $(id);
    const out = $(id + '-out');
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      state[key] = v / 100;
      out.value = v;
    });
  });

  // Trainer
  $('trainer-on').addEventListener('change', e => {
    state.trainerEnabled = e.target.checked;
    renderActiveTrainers();
  });
  $('trainer-start').addEventListener('change', e => state.trainerStart = Number(e.target.value));
  $('trainer-end').addEventListener('change', e => state.trainerEnd = Number(e.target.value));
  $('trainer-step').addEventListener('change', e => state.trainerStep = Number(e.target.value));
  $('trainer-bars').addEventListener('change', e => state.trainerBars = Number(e.target.value));

  // Mute (bar-pattern: play N bars, skip M bars, repeat)
  $('mute-on').addEventListener('change', e => {
    state.muteEnabled = e.target.checked;
    renderActiveTrainers();
  });
  $('mute-play-bars').addEventListener('change', e => {
    state.mutePlayBars = Math.max(1, Number(e.target.value) || 1);
    e.target.value = state.mutePlayBars;
  });
  $('mute-skip-bars').addEventListener('change', e => {
    state.muteSkipBars = Math.max(1, Number(e.target.value) || 1);
    e.target.value = state.muteSkipBars;
  });

  // Mic timing trainer
  $('mic-on').addEventListener('change', async e => {
    if (e.target.checked) {
      if (state.isPlaying) {
        e.target.checked = false;
        setMicStatus('Останови метроном перед включением — нужно прогнать тестовый клик и проверить, не идёт ли звук через динамик.');
        showToast('Сначала останови метроном');
        renderActiveTrainers();
        return;
      }
      renderActiveTrainers();
      await startMic();
      // startMic may have aborted (no headphones / permission denied);
      // re-render to drop the tag if the checkbox flipped back.
      renderActiveTrainers();
    } else {
      stopMic();
      renderActiveTrainers();
    }
  });

  // Bluetooth latency — manual controls
  const btLag = $('bt-lag');
  const btLagOut = $('bt-lag-out');
  btLag.addEventListener('input', () => {
    if (state.autoBtLatency) return;  // ignore while auto is on
    state.btLatencyMs = Number(btLag.value);
    btLagOut.value = state.btLatencyMs;
    localStorage.setItem(BT_LATENCY_KEY, String(state.btLatencyMs));
  });
  document.querySelectorAll('[data-bt-preset]').forEach(b => {
    b.addEventListener('click', () => {
      if (state.autoBtLatency) return;
      const v = Number(b.dataset.btPreset);
      state.btLatencyMs = v;
      btLag.value = v;
      btLagOut.value = v;
      localStorage.setItem(BT_LATENCY_KEY, String(v));
    });
  });

  // Bluetooth latency — auto toggle
  $('bt-auto').addEventListener('change', e => {
    state.autoBtLatency = e.target.checked;
    localStorage.setItem(BT_AUTO_KEY, state.autoBtLatency ? '1' : '0');
    updateBtLatencyUI();
    // If we're playing, immediately re-detect; otherwise fires on next start
    if (state.autoBtLatency && state.isPlaying) detectBtLatency();
  });

  // Presets
  $('preset-save').addEventListener('click', saveCurrentAsPreset);

  // Analytics opt-out — gating happens in the inline <head> script (it
  // skips loading the Yandex Metrika tag if the key is set). Mid-session
  // toggling pauses/resumes via ym() so the change applies immediately.
  const analyticsOn = $('analytics-on');
  if (analyticsOn) {
    analyticsOn.checked = localStorage.getItem(ANALYTICS_DISABLED_KEY) !== '1';
    analyticsOn.addEventListener('change', () => {
      const enabled = analyticsOn.checked;
      try {
        if (enabled) localStorage.removeItem(ANALYTICS_DISABLED_KEY);
        else localStorage.setItem(ANALYTICS_DISABLED_KEY, '1');
      } catch {}
      try {
        if (typeof window.ym === 'function') {
          window.ym(109016048, enabled ? 'resumeTracking' : 'pauseTracking');
        }
      } catch {}
    });
  }

  // Reset settings — clears the settings keys and reloads. User content
  // (rhythms, BPM presets) is preserved.
  $('settings-reset').addEventListener('click', () => {
    if (!confirm('Сбросить все настройки до значений по умолчанию?')) return;
    for (const key of RESETTABLE_KEYS) {
      try { localStorage.removeItem(key); } catch {}
    }
    location.reload();
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'KeyT') { e.preventDefault(); tap(); }
    else if (e.code === 'Escape') {
      closeModal('sub-modal');
      closeModal('time-modal');
      closeModal('presets-modal');
      closeModal('countin-modal');
      closeModal('program-preview-modal');
      if ($('flash-screen').classList.contains('open')) closeFlashScreen();
      if ($('program-runner').classList.contains('open')) attemptCloseRunner();
    }
  });

  document.addEventListener('gesturestart', e => e.preventDefault());

  // Re-acquire screen wake lock when returning to the tab while playing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.isPlaying) {
      requestWakeLock();
    }
  });
}

// --- Service Worker & Version ---

let swRegistration = null;

function showToast(msg) {
  const toast = $('update-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 3000);
}

function setupVersionAndUpdate() {
  const versionLabel = $('app-version');
  const updateBtn = $('update-btn');

  if (versionLabel) versionLabel.textContent = 'v' + APP_VERSION;

  if (sessionStorage.getItem('sw-updated')) {
    sessionStorage.removeItem('sw-updated');
    setTimeout(() => showToast('Приложение обновлено до v' + APP_VERSION), 500);
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('./sw.js').then(reg => {
      swRegistration = reg;
    }).catch(() => {});

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      sessionStorage.setItem('sw-updated', '1');
      location.reload();
    });
  }

  if (!updateBtn) return;

  updateBtn.addEventListener('click', () => {
    if (!swRegistration) {
      showToast('Вы используете актуальную версию приложения');
      return;
    }
    updateBtn.disabled = true;

    if (swRegistration.waiting) {
      swRegistration.waiting.postMessage({ type: 'SKIP_WAITING' });
      return;
    }

    const timeout = setTimeout(() => {
      showToast('Вы используете актуальную версию приложения');
      updateBtn.disabled = false;
    }, 5000);

    swRegistration.addEventListener('updatefound', () => {
      clearTimeout(timeout);
      const newWorker = swRegistration.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed') {
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    }, { once: true });

    swRegistration.update().catch(() => {
      clearTimeout(timeout);
      showToast('Вы используете актуальную версию приложения');
      updateBtn.disabled = false;
    });
  });
}

// --- Active trainer tags ---
//
// One pill per enabled trainer rendered under the Start button. Click ×
// flips the corresponding checkbox to off and dispatches `change` so the
// existing handler tears the trainer down (stopMic / state flags / etc.).
const TRAINER_DEFS = [
  { checkboxId: 'mic-on',     label: 'Тренажёр ритма' },
  { checkboxId: 'trainer-on', label: 'Speed Trainer' },
  { checkboxId: 'mute-on',    label: 'Пропуск тактов' },
];

function renderActiveTrainers() {
  const root = $('active-trainers');
  if (!root) return;
  root.innerHTML = '';
  for (const def of TRAINER_DEFS) {
    const cb = $(def.checkboxId);
    if (!cb || !cb.checked) continue;
    const tag = document.createElement('div');
    tag.className = 'trainer-tag';
    tag.innerHTML = `
      <span>${def.label}</span>
      <button class="trainer-tag-close" aria-label="Выключить ${def.label}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <line x1="6" y1="6" x2="18" y2="18"/>
          <line x1="18" y1="6" x2="6" y2="18"/>
        </svg>
      </button>
    `;
    tag.querySelector('button').addEventListener('click', () => {
      cb.checked = false;
      cb.dispatchEvent(new Event('change'));
      // Stop the metronome too — leaving a trainer mode usually means
      // ending the practice session, so playing on would be surprising.
      if (state.isPlaying) stop();
    });
    root.appendChild(tag);
  }
}

// --- Microphone timing trainer (Stage 1 MVP) ---
//
// Listens to the mic, runs an energy-based onset detector with adaptive
// threshold and refractory period, matches each detected onset to the
// nearest scheduled beat, displays the offset in ms with a quality
// label. Headphones required to keep the metronome out of the mic.

const ONSET_REFRACTORY_SEC = 0.06;     // ignore re-triggers within 60 ms
const ONSET_THRESHOLD_MULT = 2.2;      // peak must exceed N× rolling avg
const ONSET_ABS_FLOOR = 0.012;         // minimum absolute RMS to consider
const ENERGY_HISTORY_LEN = 30;         // sliding window for adaptive baseline
const MATCH_WINDOW_MS = 250;           // farther than this = ignored
const QUALITY_BANDS = [
  { abs:  10, label: 'идеально', key: 'perfect' },
  { abs:  25, label: 'хорошо',   key: 'good' },
  { abs:  50, label: 'ок',       key: 'ok' },
  { abs: Infinity, label: 'мимо', key: 'miss' },
];

const mic = {
  stream: null,
  source: null,
  analyser: null,
  buf: null,
  energyHistory: [],
  lastOnsetTime: 0,
  rafId: 0,
};

async function startMic() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Микрофон не поддерживается этим браузером');
    }
    setMicStatus('Запрашиваю доступ к микрофону…');
    await ensureAudio();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    mic.stream = stream;
    mic.source = audioCtx.createMediaStreamSource(stream);
    mic.analyser = audioCtx.createAnalyser();
    mic.analyser.fftSize = 1024;
    mic.buf = new Float32Array(mic.analyser.fftSize);
    mic.source.connect(mic.analyser);
    mic.energyHistory.length = 0;
    mic.lastOnsetTime = 0;

    // Verify the metronome is going to the headphones, not the speaker:
    // play one test click and see whether the mic picks it up.
    setMicStatus('Проверяю звук… играем один клик.');
    const result = await runLoopbackTest();

    if (!result.headphones) {
      stopMic();
      $('mic-on').checked = false;
      setMicStatus(
        'Похоже, звук идёт через динамик — микрофон поймал тестовый клик ' +
        `(peak ${result.peakRms.toFixed(3)}, baseline ${result.baseline.toFixed(3)}). ` +
        'Подключи наушники и попробуй ещё раз.'
      );
      showToast('Подключи наушники');
      return;
    }

    state.micEnabled = true;
    micTick();
    updateMicUI();
    setMicStatus('Слушаю микрофон. Включи метроном и сыграй удар.');
  } catch (e) {
    state.micEnabled = false;
    $('mic-on').checked = false;
    setMicStatus('Не получилось включить микрофон: ' + (e.message || e.name || 'неизвестная ошибка'));
    showToast('Микрофон недоступен');
  }
}

// Plays a single test click and watches the mic for ~250 ms after.
// If peak RMS in that window is above the absolute floor AND ≥3× the
// pre-click baseline, the mic likely heard the click → no headphones.
function runLoopbackTest() {
  return new Promise(resolve => {
    if (!mic.analyser || !audioCtx) {
      resolve({ headphones: true, peakRms: 0, baseline: 0, reason: 'no-audio' });
      return;
    }

    const baselineStart = audioCtx.currentTime;
    const clickAt = baselineStart + 0.20;        // schedule click 200 ms ahead
    const baselineEnd = clickAt - 0.03;          // sample baseline up to 30 ms before click
    const peakStart = clickAt - 0.03;
    const peakEnd = clickAt + 0.20;
    const finishAt = peakEnd + 0.02;

    playClick('beat', clickAt);

    let peakRms = 0;
    const baselineSamples = [];

    function tick() {
      if (!mic.analyser) {
        resolve({ headphones: true, peakRms, baseline: 0, reason: 'mic-stopped' });
        return;
      }
      const now = audioCtx.currentTime;

      mic.analyser.getFloatTimeDomainData(mic.buf);
      let sumSq = 0;
      for (let i = 0; i < mic.buf.length; i++) sumSq += mic.buf[i] * mic.buf[i];
      const rms = Math.sqrt(sumSq / mic.buf.length);

      if (now >= baselineStart && now < baselineEnd) {
        baselineSamples.push(rms);
      } else if (now >= peakStart && now < peakEnd) {
        if (rms > peakRms) peakRms = rms;
      }

      if (now >= finishAt) {
        const baseline = baselineSamples.length
          ? baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length
          : 0;
        const heard = peakRms > 0.02 && peakRms > baseline * 3;
        resolve({ headphones: !heard, peakRms, baseline });
        return;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function stopMic() {
  state.micEnabled = false;
  if (mic.rafId) cancelAnimationFrame(mic.rafId);
  mic.rafId = 0;
  if (mic.source) try { mic.source.disconnect(); } catch {}
  if (mic.stream) mic.stream.getTracks().forEach(t => t.stop());
  mic.stream = null;
  mic.source = null;
  mic.analyser = null;
  mic.buf = null;
  mic.energyHistory.length = 0;
  updateMicUI();
  setMicStatus('Выключен.');
}

function micTick() {
  if (!state.micEnabled || !mic.analyser) return;
  mic.analyser.getFloatTimeDomainData(mic.buf);

  // RMS over the buffer
  let sumSq = 0;
  for (let i = 0; i < mic.buf.length; i++) sumSq += mic.buf[i] * mic.buf[i];
  const rms = Math.sqrt(sumSq / mic.buf.length);

  // Adaptive baseline: rolling average of recent RMS values
  mic.energyHistory.push(rms);
  if (mic.energyHistory.length > ENERGY_HISTORY_LEN) mic.energyHistory.shift();
  const avg = mic.energyHistory.reduce((a, b) => a + b, 0) / mic.energyHistory.length;

  const now = audioCtx.currentTime;
  if (rms > ONSET_ABS_FLOOR
      && rms > avg * ONSET_THRESHOLD_MULT
      && now - mic.lastOnsetTime > ONSET_REFRACTORY_SEC) {
    onMicOnset(now);
    mic.lastOnsetTime = now;
  }

  mic.rafId = requestAnimationFrame(micTick);
}

function onMicOnset(time) {
  if (!state.isPlaying) return;
  // Compensate for system input latency: the mic sample arrived at `time`,
  // but the actual hit happened a few ms earlier.
  const adjusted = time - state.inputLatencyMs / 1000;

  // Find nearest scheduled beat (sub === 0) across both upcoming and recent
  let nearest = null;
  let bestAbs = Infinity;
  const candidates = notesInQueue.concat(recentBeats);
  for (const n of candidates) {
    if (n.sub !== 0) continue;
    const delta = adjusted - n.time;
    if (Math.abs(delta) < bestAbs) {
      bestAbs = Math.abs(delta);
      nearest = { delta, beat: n };
    }
  }

  if (!nearest) return;
  const offsetMs = Math.round(nearest.delta * 1000);
  if (Math.abs(offsetMs) > MATCH_WINDOW_MS) return;
  showOffset(offsetMs);
}

function showOffset(offsetMs) {
  const liveEl = $('mic-live');
  const offEl = $('mic-live-offset');
  const qualEl = $('mic-live-quality');
  if (!liveEl) return;

  const abs = Math.abs(offsetMs);
  const band = QUALITY_BANDS.find(b => abs <= b.abs);

  const sign = offsetMs > 0 ? '+' : (offsetMs < 0 ? '−' : '');
  // Use minus sign only via prefix; show absolute value
  offEl.textContent = abs < 5 ? 'точно' : `${sign}${abs} мс`;
  qualEl.textContent = band.label;
  liveEl.dataset.quality = band.key;
}

function updateMicUI() {
  const liveEl = $('mic-live');
  if (!liveEl) return;
  if (state.micEnabled) {
    liveEl.hidden = false;
    if (!liveEl.dataset.quality) {
      $('mic-live-offset').textContent = '—';
      $('mic-live-quality').textContent = 'жду удара';
    }
  } else {
    liveEl.hidden = true;
    delete liveEl.dataset.quality;
    $('mic-live-offset').textContent = '—';
    $('mic-live-quality').textContent = '';
  }
}

function setMicStatus(text) {
  const el = $('mic-status');
  if (el) el.textContent = text;
}

// --- Screen Wake Lock (keeps phone from sleeping while playing) ---

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (wakeLockSentinel) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      // Browser may auto-release on tab hide; we re-request on visibilitychange.
      wakeLockSentinel = null;
    });
  } catch {
    // Wake Lock can fail if the page isn't visible or on unsupported browsers.
    wakeLockSentinel = null;
  }
}

function releaseWakeLock() {
  if (!wakeLockSentinel) return;
  wakeLockSentinel.release().catch(() => {});
  wakeLockSentinel = null;
}

// --- Bluetooth latency detection ---

function detectBtLatency() {
  if (!state.autoBtLatency) return;
  if (!audioCtx || typeof audioCtx.outputLatency !== 'number') return;
  const detectedMs = Math.round(audioCtx.outputLatency * 1000);
  // Some browsers/devices return 0 in the first tick — leave previous value.
  if (detectedMs <= 0) return;
  state.btLatencyMs = detectedMs;
  updateBtLatencyUI();
}

function updateBtLatencyUI() {
  const lag = $('bt-lag');
  const lagOut = $('bt-lag-out');
  const detected = $('bt-detected');
  if (lag) lag.value = state.btLatencyMs;
  if (lagOut) lagOut.value = state.btLatencyMs;
  if (detected) {
    detected.textContent = state.autoBtLatency
      ? (state.btLatencyMs > 0 ? state.btLatencyMs + ' мс' : '— (нажми СТАРТ)')
      : '—';
  }
  // Lock the slider/presets when auto mode is on
  const lagRow = $('bt-lag-row');
  const presets = $('bt-presets');
  if (lagRow) lagRow.classList.toggle('disabled-control', state.autoBtLatency);
  if (presets) presets.classList.toggle('disabled-control', state.autoBtLatency);
}

// --- Fullscreen flash view ---

function openFlashScreen() {
  // Build big stacks if not yet built (or rebuild on first open after a sig change)
  renderBeatStacks('flash-beat-indicator');
  // Sync info displays from current state
  $('flash-bpm').textContent = state.bpm;
  $('flash-timesig').textContent = `${state.beatsPerMeasure}/${state.beatUnit}`;
  $('flash-sub').textContent = SUB_META[state.subdivision]?.symbol || '♩';
  // Re-apply current beat highlight (so an already-playing metronome shows up)
  if (state.isPlaying) {
    document.querySelectorAll('.beat-stack').forEach(s => {
      const isActive = Number(s.dataset.beat) === state.currentBeat;
      s.classList.toggle('active', isActive);
    });
  }
  const el = $('flash-screen');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function closeFlashScreen() {
  const el = $('flash-screen');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  // Lamp mode is scoped to fullscreen — turn off when leaving
  if (state.flashEnabled) setFlashMode(false);
}

function setFlashMode(on) {
  state.flashEnabled = !!on;
  const lamp = $('flash-lamp');
  if (lamp) lamp.setAttribute('aria-pressed', state.flashEnabled ? 'true' : 'false');
  const screen = $('flash-screen');
  if (screen) screen.classList.toggle('lamp-on', state.flashEnabled);
}

function toggleLamp() { setFlashMode(!state.flashEnabled); }

// --- Count-in (delayed start) ---

// Picking a duration only ARMS the count-in; the countdown itself runs
// when the user presses Start. countinSec is the chosen delay (0 = off);
// countinActive flips true only while the countdown overlay is showing.

function setCountinSec(sec) {
  state.countinSec = sec > 0 ? sec : 0;
  updateCountinUI();
}

function updateCountinUI() {
  const btn = $('countin-btn');
  if (!btn) return;
  const armed = state.countinSec > 0;
  btn.classList.toggle('armed', armed);
  const numEl = $('countin-btn-num');
  if (numEl) numEl.textContent = armed ? state.countinSec : '';
  // Also reflect the current selection back into the modal so user sees
  // which option is active when they re-open it.
  document.querySelectorAll('.countin-option').forEach(b => {
    b.classList.toggle('is-active', Number(b.dataset.sec) === state.countinSec);
  });
}

// Called from start() when state.countinSec > 0. The metronome itself is
// already running by the time we get here — we just show a big-number
// overlay that counts down from N to 0, then clears.
function runCountdownOverlay(sec) {
  state.countinActive = true;
  const overlay = $('countin-overlay');
  const num = $('countin-num');
  let remaining = sec;
  num.textContent = remaining;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  state.countinTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) finishCountin();
    else num.textContent = remaining;
  }, 1000);
}

function finishCountin() {
  if (state.countinTimer) {
    clearInterval(state.countinTimer);
    state.countinTimer = null;
  }
  state.countinActive = false;
  const overlay = $('countin-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

function cancelCountin() { finishCountin(); }

// --- Programs runtime (state, UI, lifecycle) ---
//
// A program is an ordered list of blocks. The runner pushes each block's
// settings into the metronome (BPM/sig/sub + optional Speed Trainer ramp)
// and counts down a per-block timer. Auto-timed blocks advance themselves;
// userPaced blocks wait for "Готово, дальше". On exit we restore the
// metronome state to what it was before the program started.

const programState = {
  active: false,
  program: null,
  blockIdx: 0,
  blockTimeRemaining: 0,        // seconds left on auto-timed block
  blockTickInterval: null,
  saved: null,                  // metronome state snapshot for exit restore
};

// User-imported programs (separate from the built-in PROGRAMS catalog).
// Persisted in localStorage; rendered in their own "Мои программы" plate
// under the difficulty/duration picker.
let userPrograms = [];

function loadUserPrograms() {
  try {
    const raw = localStorage.getItem(USER_PROGRAMS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) userPrograms = arr.filter(p => p && p.id);
  } catch {}
}

function saveUserPrograms() {
  try { localStorage.setItem(USER_PROGRAMS_KEY, JSON.stringify(userPrograms)); } catch {}
}

function renderUserPrograms() {
  const section = $('user-programs-section');
  const list = $('user-programs-list');
  if (!section || !list) return;
  list.innerHTML = '';
  if (!userPrograms.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  for (const p of userPrograms) {
    const row = document.createElement('div');
    row.className = 'user-program-row';
    const totalMin = Math.round(totalProgramSeconds(p) / 60) || p.duration || 0;
    row.innerHTML = `
      <button class="user-program-load">
        <span class="user-program-name"></span>
        <span class="user-program-duration"></span>
      </button>
      <button class="user-program-delete" aria-label="Удалить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    `;
    row.querySelector('.user-program-name').textContent = p.name;
    row.querySelector('.user-program-duration').textContent = `${totalMin} мин · ${p.blocks.length} блоков`;
    row.querySelector('.user-program-load').addEventListener('click', () => openProgramPreview(p.id));
    row.querySelector('.user-program-delete').addEventListener('click', () => {
      if (confirm(`Удалить «${p.name}»?`)) removeUserProgram(p.id);
    });
    list.appendChild(row);
  }
}

function addUserProgram(p) {
  userPrograms.push(p);
  saveUserPrograms();
  renderUserPrograms();
}

function removeUserProgram(id) {
  userPrograms = userPrograms.filter(p => p.id !== id);
  saveUserPrograms();
  renderUserPrograms();
}

// --- Import: parse + validate program packages ---
//
// Accepts three input shapes:
//   1) Raw JSON string starting with `{`
//   2) Full deeplink URL containing ?import=<base64-json>
//   3) Bare base64-encoded JSON
//
// Returns the parsed program object on success; throws an Error with a
// short Russian message on failure (shown to the user in a toast).
const PROGRAM_BLOCK_TYPES = new Set(['warmup', 'rudiment', 'coordination', 'song', 'cooldown']);
const PROGRAM_EXERCISE_KINDS = new Set(['sticking', 'groove', 'free', 'song']);
const PROGRAM_SCHEMA_VERSION = 1;

function decodeBase64Json(b64) {
  // atob accepts standard base64. We strip whitespace and apply padding
  // so that base64 strings copied from anywhere (including URL-safe
  // variants the model may emit) decode cleanly.
  let s = String(b64).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  // atob gives latin-1 bytes; convert to UTF-8 string for JSON.parse.
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  const text = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(text);
}

function parseImportInput(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Пусто');
  // Direct JSON
  if (text.startsWith('{')) {
    try { return JSON.parse(text); }
    catch { throw new Error('JSON повреждён'); }
  }
  // URL with ?import=
  if (/^https?:\/\//i.test(text) || text.includes('?import=')) {
    try {
      const url = new URL(text, location.origin);
      const param = url.searchParams.get('import');
      if (!param) throw new Error('В ссылке нет параметра import=');
      return decodeBase64Json(param);
    } catch (e) {
      if (e.message === 'В ссылке нет параметра import=') throw e;
      throw new Error('Ссылка повреждена');
    }
  }
  // Otherwise assume bare base64
  try { return decodeBase64Json(text); }
  catch { throw new Error('Не удалось распознать формат — ожидается JSON, ссылка или base64'); }
}

function validateProgram(p) {
  if (!p || typeof p !== 'object') throw new Error('Программа не является объектом');
  if (p.schemaVersion !== PROGRAM_SCHEMA_VERSION) {
    throw new Error(`Несовместимая версия формата (нужна ${PROGRAM_SCHEMA_VERSION})`);
  }
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('Нет названия программы');
  if (!Number.isFinite(p.duration) || p.duration <= 0) throw new Error('Не указана длительность');
  if (!Array.isArray(p.blocks) || !p.blocks.length) throw new Error('Программа должна содержать хотя бы один блок');
  p.blocks.forEach((b, idx) => {
    const where = `блок ${idx + 1}`;
    if (!b || typeof b !== 'object') throw new Error(`${where}: не объект`);
    if (!PROGRAM_BLOCK_TYPES.has(b.type)) throw new Error(`${where}: неизвестный type «${b.type}»`);
    if (typeof b.title !== 'string' || !b.title.trim()) throw new Error(`${where}: нет title`);
    if (!Number.isFinite(b.duration) || b.duration <= 0) throw new Error(`${where}: некорректный duration`);
    if (!Number.isFinite(b.bpm) || b.bpm < 30 || b.bpm > 320) throw new Error(`${where}: bpm вне диапазона 30–320`);
    if (!b.sig || !Number.isFinite(b.sig.num) || !Number.isFinite(b.sig.den)) throw new Error(`${where}: некорректный sig`);
    if (![1, 2, 3, 4].includes(b.sub)) throw new Error(`${where}: sub должен быть 1, 2, 3 или 4`);
    if (!b.exercise || typeof b.exercise !== 'object') throw new Error(`${where}: нет exercise`);
    if (!PROGRAM_EXERCISE_KINDS.has(b.exercise.kind)) throw new Error(`${where}: неизвестный exercise.kind «${b.exercise.kind}»`);
    if (b.bpmRamp != null) {
      const r = b.bpmRamp;
      if (!Number.isFinite(r.to) || !Number.isFinite(r.step) || !Number.isFinite(r.every)) {
        throw new Error(`${where}: bpmRamp должен содержать to, step, every`);
      }
    }
  });
  return p;
}

// Convert a validated package into the internal program shape (assigns
// an id; user programs don't have a difficulty).
function packageToProgram(pkg) {
  return {
    id: 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    name: pkg.name.trim(),
    duration: pkg.duration,
    description: pkg.description || '',
    blocks: pkg.blocks,
  };
}

// --- Import modal flow ---
//
// Two stages: an input sheet (paste raw JSON / link / base64), then a
// confirm sheet showing the parsed program preview. The same confirm
// sheet is reused by the deeplink boot handler.
let pendingImportProgram = null;

function openImportModal() {
  const input = $('import-input');
  if (input) input.value = '';
  showImportError('');
  openModal('import-modal');
}

function showImportError(msg) {
  const el = $('import-error');
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

async function pasteImportFromClipboard() {
  showImportError('');
  // iOS / older browsers: clipboard.readText is gated behind secure
  // context (HTTPS) and may be missing on plain http:// LAN testing.
  // In that case fall back to focusing the textarea so the user can
  // do a long-tap → Paste manually.
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    showImportError('Браузер не разрешает чтение буфера. Сделай длинный тап по полю ниже и выбери «Вставить».');
    $('import-input').focus();
    return;
  }
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    showImportError('iOS не разрешил доступ к буферу. Сделай длинный тап по полю ниже и выбери «Вставить».');
    $('import-input').focus();
    return;
  }
  if (!text || !text.trim()) {
    showImportError('Буфер обмена пуст. Скопируй ссылку или JSON и попробуй ещё раз.');
    return;
  }
  $('import-input').value = text;
  // Auto-submit so the user goes straight from "Из буфера" to the
  // preview sheet — no second tap on "Далее" needed.
  submitImport();
}

function submitImport() {
  showImportError('');
  const raw = $('import-input').value;
  let pkg;
  try {
    pkg = parseImportInput(raw);
    validateProgram(pkg);
  } catch (e) {
    showImportError(e.message || 'Не удалось импортировать');
    return;
  }
  closeModal('import-modal');
  showImportConfirm(pkg);
}

function showImportConfirm(pkg) {
  const program = packageToProgram(pkg);
  pendingImportProgram = program;
  $('import-confirm-title').textContent = `Импортировать «${program.name}»?`;
  const totalMin = Math.round(totalProgramSeconds(program) / 60) || program.duration || 0;
  $('import-confirm-meta').textContent = `${program.blocks.length} блоков · итого ≈ ${totalMin} мин`;
  const desc = $('import-confirm-description');
  desc.textContent = program.description || '';
  desc.hidden = !program.description;
  const list = $('import-confirm-blocks');
  list.innerHTML = '';
  program.blocks.forEach(block => {
    const li = document.createElement('li');
    li.className = 'program-preview-block';
    const min = Math.round((block.duration || 0) / 60);
    const minTxt = block.userPaced ? `≈ ${min} мин` : `${min} мин`;
    const ramp = block.bpmRamp ? `${block.bpm}→${block.bpmRamp.to}` : `${block.bpm}`;
    const typeLabel = BLOCK_TYPE_LABELS[block.type] || '';
    li.innerHTML = `
      <span class="program-preview-block-type"></span>
      <span class="program-preview-block-title"></span>
      <span class="program-preview-block-meta"></span>
    `;
    li.querySelector('.program-preview-block-type').textContent = typeLabel;
    li.querySelector('.program-preview-block-title').textContent = block.title;
    li.querySelector('.program-preview-block-meta').textContent = `${minTxt} · ${ramp} BPM`;
    list.appendChild(li);
  });
  openModal('import-confirm-modal');
}

function confirmImportSave() {
  if (!pendingImportProgram) return;
  addUserProgram(pendingImportProgram);
  showToast(`«${pendingImportProgram.name}» добавлена в Мои программы`);
  pendingImportProgram = null;
  closeModal('import-confirm-modal');
}

function cancelImportConfirm() {
  pendingImportProgram = null;
  closeModal('import-confirm-modal');
}

function getProgramById(id) {
  return PROGRAMS.find(p => p.id === id) || userPrograms.find(p => p.id === id);
}

function totalProgramSeconds(p) {
  return p.blocks.reduce((s, b) => s + (b.duration || 0), 0);
}

function formatMMSS(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// User picks difficulty + duration in two sheets, then taps "Далее" to
// open the preview for the matching program. Both selections persist
// only as picker state — they're not saved between sessions.
const programPicker = {
  difficulty: null,  // 'beginner' | 'intermediate' | 'advanced'
  duration: null,    // 15 | 30 | 60
};

function syncProgramPickerUI() {
  const dEl = $('program-difficulty-text');
  const tEl = $('program-duration-text');
  const next = $('program-next');
  if (!dEl || !tEl || !next) return;
  if (programPicker.difficulty) {
    dEl.textContent = DIFFICULTY_LABELS[programPicker.difficulty];
    dEl.classList.add('is-filled');
  } else {
    dEl.textContent = 'Сложность';
    dEl.classList.remove('is-filled');
  }
  if (programPicker.duration) {
    tEl.textContent = `${programPicker.duration} мин`;
    tEl.classList.add('is-filled');
  } else {
    tEl.textContent = 'Длительность';
    tEl.classList.remove('is-filled');
  }
  // Visually disabled but always clickable, so a tap can show the
  // "выберите ..." toast instead of being silently ignored.
  next.classList.toggle('is-disabled', !(programPicker.difficulty && programPicker.duration));
}

function openProgramDifficultySheet() {
  const root = document.querySelector('#program-difficulty-modal .program-picker-options');
  if (root) {
    root.querySelectorAll('.program-picker-option').forEach(b => {
      b.classList.toggle('is-active', b.dataset.difficulty === programPicker.difficulty);
    });
  }
  openModal('program-difficulty-modal');
}

function openProgramDurationSheet() {
  const root = document.querySelector('#program-duration-modal .program-picker-options');
  if (root) {
    root.querySelectorAll('.program-picker-option').forEach(b => {
      b.classList.toggle('is-active', Number(b.dataset.duration) === programPicker.duration);
    });
  }
  openModal('program-duration-modal');
}

function openProgramPreview(id) {
  const p = getProgramById(id);
  if (!p) return;
  $('program-preview-title').textContent = p.name;
  const totalMin = Math.round(totalProgramSeconds(p) / 60);
  $('program-preview-meta').textContent = `${p.blocks.length} блоков · итого ≈ ${totalMin} мин`;
  const desc = $('program-preview-description');
  desc.textContent = p.description || '';
  desc.hidden = !p.description;
  const list = $('program-preview-blocks');
  list.innerHTML = '';
  p.blocks.forEach(block => {
    const li = document.createElement('li');
    li.className = 'program-preview-block';
    const min = Math.round((block.duration || 0) / 60);
    const minTxt = block.userPaced ? `≈ ${min} мин` : `${min} мин`;
    const ramp = block.bpmRamp ? `${block.bpm}→${block.bpmRamp.to}` : `${block.bpm}`;
    li.innerHTML = `
      <span class="program-preview-block-type">${BLOCK_TYPE_LABELS[block.type] || ''}</span>
      <span class="program-preview-block-title">${block.title}</span>
      <span class="program-preview-block-meta">${minTxt} · ${ramp} BPM</span>
    `;
    list.appendChild(li);
  });
  $('program-start').dataset.programId = id;
  openModal('program-preview-modal');
}

function startProgram(id) {
  const p = getProgramById(id);
  if (!p) return;
  if (state.isPlaying) stop();
  // Snapshot metronome state so we can restore on exit
  programState.saved = {
    bpm: state.bpm,
    num: state.beatsPerMeasure,
    den: state.beatUnit,
    sub: state.subdivision,
    beatTypes: state.beatTypes.slice(),
    trainerEnabled: state.trainerEnabled,
    trainerStart: state.trainerStart,
    trainerEnd: state.trainerEnd,
    trainerStep: state.trainerStep,
    trainerBars: state.trainerBars,
    activePresetSig: state.activePresetSig,
  };
  programState.active = true;
  programState.program = p;
  programState.blockIdx = 0;
  state.activePresetSig = null;  // programs override metronome state, drop preset highlight
  closeModal('program-preview-modal');
  openRunner();
  loadBlock(0);
  startBlockTicker();
}

function openRunner() {
  $('runner-program-name').textContent = programState.program.name;
  const el = $('program-runner');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function closeRunnerNow() {
  const el = $('program-runner');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  hideTransition();
  hideFinish();
}

function exitProgram() {
  if (state.isPlaying) stop();
  stopBlockTicker();
  if (programState.saved) {
    const s = programState.saved;
    setBpm(s.bpm);
    state.beatsPerMeasure = s.num;
    state.beatUnit = s.den;
    state.subdivision = s.sub;
    state.beatTypes = s.beatTypes.slice();
    state.trainerEnabled = s.trainerEnabled;
    state.trainerStart = s.trainerStart;
    state.trainerEnd = s.trainerEnd;
    state.trainerStep = s.trainerStep;
    state.trainerBars = s.trainerBars;
    state.activePresetSig = s.activePresetSig;
    // Sync the trainer UI on the Training tab so what user sees matches state
    const tOn = $('trainer-on');
    if (tOn) tOn.checked = state.trainerEnabled;
    const tStart = $('trainer-start'); if (tStart) tStart.value = state.trainerStart;
    const tEnd   = $('trainer-end');   if (tEnd)   tEnd.value   = state.trainerEnd;
    const tStep  = $('trainer-step');  if (tStep)  tStep.value  = state.trainerStep;
    const tBars  = $('trainer-bars');  if (tBars)  tBars.value  = state.trainerBars;
    rebuildBeatIndicator();
    updateSubDisplay();
    updateTimeDisplay();
    renderActiveTrainers();
  }
  programState.active = false;
  programState.program = null;
  programState.saved = null;
  closeRunnerNow();
}

function loadBlock(idx) {
  const block = programState.program.blocks[idx];
  if (!block) return;
  programState.blockIdx = idx;
  programState.blockTimeRemaining = block.duration || 0;

  // Push block params into metronome (without starting playback)
  setBpm(block.bpm);
  state.beatsPerMeasure = block.sig.num;
  state.beatUnit = block.sig.den;
  state.subdivision = block.sub;
  state.currentBeat = 0;
  state.currentSub = 0;
  // Reset beat types so first beat is accent and rest are plain — programs
  // shouldn't inherit user's per-beat customizations from before
  state.beatTypes = Array(block.sig.num).fill('beat');
  state.beatTypes[0] = 'accent';
  rebuildBeatIndicator();
  updateSubDisplay();
  updateTimeDisplay();

  // BPM ramp drives the existing Speed Trainer plumbing
  if (block.bpmRamp) {
    state.trainerEnabled = true;
    state.trainerStart = block.bpm;
    state.trainerEnd = block.bpmRamp.to;
    state.trainerStep = block.bpmRamp.step;
    state.trainerBars = block.bpmRamp.every;
  } else {
    state.trainerEnabled = false;
  }
  state.trainerBarCount = 0;

  renderRunnerBlock(block);
}

function renderRunnerBlock(block) {
  $('runner-block-type').textContent = BLOCK_TYPE_LABELS[block.type] || '';
  $('runner-block-title').textContent = block.title;
  $('runner-block-pos').textContent =
    `Блок ${programState.blockIdx + 1} / ${programState.program.blocks.length}`;
  $('runner-bpm').textContent = block.bpmRamp ? `${block.bpm} → ${block.bpmRamp.to}` : block.bpm;
  $('runner-sig').textContent = `${block.sig.num}/${block.sig.den}`;
  $('runner-sub').textContent = SUB_META[block.sub]?.symbol || '♩';

  const ex = block.exercise || {};
  const exEl = $('runner-exercise');
  exEl.innerHTML = '';
  exEl.dataset.kind = ex.kind || 'free';
  if (ex.kind === 'sticking' && ex.pattern) {
    const p = document.createElement('div');
    p.className = 'runner-sticking';
    p.textContent = ex.pattern;
    exEl.appendChild(p);
  } else if (ex.kind === 'groove' && ex.grid) {
    exEl.appendChild(buildGrooveGrid(ex.grid));
  }

  const ref = $('runner-reference');
  ref.textContent = ex.reference || '';
  ref.hidden = !ex.reference;
  $('runner-notes').textContent = ex.notes || '';

  const done = $('runner-done');
  const timer = $('runner-timer');
  const extend = $('runner-extend');
  if (block.userPaced) {
    done.hidden = false;
    extend.disabled = true;
    timer.textContent = block.duration ? `≈ ${formatMMSS(block.duration)}` : '—';
    timer.dataset.userPaced = 'true';
  } else {
    done.hidden = true;
    extend.disabled = false;
    timer.dataset.userPaced = 'false';
    updateRunnerTimerUI();
  }
  updateRunnerProgressUI();
  // Reflect current metronome play state on the runner play button
  if (typeof updatePlayButton === 'function') updatePlayButton();
}

function buildGrooveGrid(grid) {
  const wrap = document.createElement('div');
  wrap.className = 'groove-grid';
  const rows = [
    { key: 'hat',   label: 'хэт',   marker: '×' },
    { key: 'snare', label: 'мал.',  marker: '●' },
    { key: 'kick',  label: 'бочка', marker: '●' },
  ];
  // Cell count = length of the first non-empty row (typically 8 or 16 in 4/4)
  let cells = 8;
  for (const r of rows) {
    if (Array.isArray(grid[r.key])) { cells = grid[r.key].length; break; }
  }
  wrap.style.setProperty('--cells', cells);
  // Highlight every Nth cell as a "beat" — assumes 4 beats/bar (cells/4 cells per beat)
  const cellsPerBeat = Math.max(1, Math.round(cells / 4));
  for (const r of rows) {
    const arr = grid[r.key];
    if (!Array.isArray(arr)) continue;
    const row = document.createElement('div');
    row.className = 'groove-row';
    row.dataset.row = r.key;
    const lbl = document.createElement('div');
    lbl.className = 'groove-label';
    lbl.textContent = r.label;
    row.appendChild(lbl);
    for (let i = 0; i < cells; i++) {
      const cell = document.createElement('div');
      cell.className = 'groove-cell';
      if (i % cellsPerBeat === 0) cell.classList.add('beat');
      if (arr[i]) {
        cell.classList.add('hit');
        cell.textContent = r.marker;
      }
      row.appendChild(cell);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function updateRunnerTimerUI() {
  const block = programState.program?.blocks[programState.blockIdx];
  if (!block || block.userPaced) return;
  $('runner-timer').textContent = formatMMSS(programState.blockTimeRemaining);
}

function updateRunnerProgressUI() {
  const block = programState.program?.blocks[programState.blockIdx];
  const fill = $('runner-progress-fill');
  if (!fill) return;
  if (!block || block.userPaced || !block.duration) {
    fill.style.width = '0%';
    return;
  }
  const elapsed = block.duration - programState.blockTimeRemaining;
  const pct = Math.max(0, Math.min(100, (elapsed / block.duration) * 100));
  fill.style.width = pct + '%';
}

// Ticks once per second while the runner is open. Only decrements time when
// the metronome is actually playing — pause = stop the metronome, and the
// block timer freezes automatically (single source of truth: state.isPlaying).
function startBlockTicker() {
  stopBlockTicker();
  programState.blockTickInterval = setInterval(() => {
    if (!programState.active) return;
    if (!state.isPlaying) return;
    const block = programState.program.blocks[programState.blockIdx];
    if (!block || block.userPaced) return;
    programState.blockTimeRemaining--;
    if (programState.blockTimeRemaining <= 0) {
      programState.blockTimeRemaining = 0;
      updateRunnerTimerUI();
      updateRunnerProgressUI();
      onBlockComplete();
    } else {
      updateRunnerTimerUI();
      updateRunnerProgressUI();
    }
  }, 1000);
}

function stopBlockTicker() {
  if (programState.blockTickInterval) {
    clearInterval(programState.blockTickInterval);
    programState.blockTickInterval = null;
  }
}

function onBlockComplete() {
  if (state.isPlaying) stop();
  const nextIdx = programState.blockIdx + 1;
  if (nextIdx >= programState.program.blocks.length) {
    showFinish();
  } else {
    showTransition(nextIdx);
  }
}

// Transition overlay — shown briefly between blocks. We pre-load the next
// block underneath so when user taps "Поехали", the play button is ready
// and the metronome is already configured for the new BPM/sig/sub.
function showTransition(nextIdx) {
  const next = programState.program.blocks[nextIdx];
  $('runner-transition-prefix').textContent =
    `Следующий блок · ${nextIdx + 1} / ${programState.program.blocks.length}`;
  $('runner-transition-title').textContent = next.title;
  const min = Math.round((next.duration || 0) / 60);
  const ramp = next.bpmRamp ? `${next.bpm}→${next.bpmRamp.to}` : `${next.bpm}`;
  const minTxt = next.userPaced ? `≈ ${min} мин` : `${min} мин`;
  $('runner-transition-meta').textContent = `${minTxt} · ${ramp} BPM`;
  loadBlock(nextIdx);
  const el = $('runner-transition');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function hideTransition() {
  const el = $('runner-transition');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

function showFinish() {
  $('runner-finish-meta').textContent =
    `${programState.program.name} · ${programState.program.blocks.length} блоков`;
  const el = $('runner-finish');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function hideFinish() {
  const el = $('runner-finish');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

function userSkipBlock() {
  if (!programState.active) return;
  onBlockComplete();
}

function userExtendBlock() {
  if (!programState.active) return;
  const block = programState.program.blocks[programState.blockIdx];
  if (!block || block.userPaced) return;
  programState.blockTimeRemaining += 120;
  // Grow the denominator too so the progress bar doesn't snap/overshoot
  block.duration += 120;
  updateRunnerTimerUI();
  updateRunnerProgressUI();
}

function userMarkDone() {
  if (!programState.active) return;
  const block = programState.program.blocks[programState.blockIdx];
  if (!block || !block.userPaced) return;
  onBlockComplete();
}

function attemptCloseRunner() {
  if (!programState.active) { closeRunnerNow(); return; }
  // Pause the metronome before showing the dialog — playing through the
  // confirm prompt would be jarring.
  if (state.isPlaying) stop();
  if (confirm('Прервать программу?')) exitProgram();
}

// --- Rhythm builder ("Конструктор ритма") ---
//
// User-drawn drum patterns. 7 voices (crash/hat/snare/tom1/tom2/tom3/kick)
// × 16 sixteenth-note cells in 4/4. Two playback modes:
//   'with-drums' — synthesized drum voices + metronome click on the beat
//   'click-only' — metronome click only (user practices the pattern)
// Patterns are persisted in localStorage as an array of
// {id, name, bpm, pattern: {voice: [0|1 × 16]}}.

const RHYTHMS_KEY = 'metronome.rhythms';
// Row order in the editor grid (top to bottom) — standard drum-tab
// vertical ordering: cymbals up top, kick at the bottom, snare and
// toms interleaved by pitch.
const RHYTHM_VOICES = [
  { key: 'ride',  label: 'райд' },
  { key: 'hat',   label: 'хэт' },
  { key: 'tom1',  label: 'том 1' },
  { key: 'snare', label: 'малый' },
  { key: 'tom2',  label: 'том 2' },
  { key: 'tom3',  label: 'том 3' },
  { key: 'kick',  label: 'бочка' },
];

// Time signatures the user can pick. `beats` = top number (drives cell
// count), `unit` = bottom number (display only). `8`-bottom signatures
// are felt as eighth-note pulses.
const TIME_SIGNATURES = [
  { beats: 2,  unit: 4 },
  { beats: 3,  unit: 4 },
  { beats: 4,  unit: 4 },
  { beats: 5,  unit: 4 },
  { beats: 6,  unit: 8 },
  { beats: 7,  unit: 8 },
  { beats: 12, unit: 8 },
];

// Subdivisions = cells per beat. Triplets share a beat with 3 cells,
// sixteenths with 4, etc. The picker labels these with a note glyph.
const DIVISIONS = [
  { value: 1, glyph: '♩',  label: 'четверти' },
  { value: 2, glyph: '♪',  label: 'восьмые' },
  { value: 3, glyph: '3',  label: 'триоли' },
  { value: 4, glyph: '♬',  label: 'шестнадцатые' },
];

// 12/8 with sixteenths or triplets balloons to 36-48 cells — too thin to
// tap on a phone. Cap at eighths for that signature only.
function allowedDivisionsFor(beats) {
  return beats === 12 ? [1, 2] : [1, 2, 3, 4];
}

let rhythms = [];

const editorState = {
  current: null,            // id of the rhythm being edited, or null = new
  pattern: null,            // { voiceKey: number[beats * division] (0|1) }
  bpm: 100,
  beats: 4,
  beatUnit: 4,
  division: 4,
  name: '',
  mode: 'with-drums',
};

// Pending size/division change waiting on the confirm sheet; null when
// no confirmation is in-flight.
let pendingMeterChange = null;

const rhythmPlayer = {
  active: false,
  cellIdx: 0,
  nextTime: 0,
  schedTimer: null,
  rafId: 0,
  cues: [],                 // {cellIdx, time}
  highlightedCell: -1,
};

function rhythmCellCount(beats = editorState.beats, division = editorState.division) {
  return beats * division;
}

function emptyPattern(beats = 4, division = 4) {
  const total = beats * division;
  const p = {};
  for (const v of RHYTHM_VOICES) p[v.key] = new Array(total).fill(0);
  return p;
}

function loadRhythms() {
  try {
    const raw = localStorage.getItem(RHYTHMS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      // Defensive: legacy entries had no beats/division and assumed 4/4
      // sixteenths. New entries persist all three so reload restores the
      // exact grid the user saved.
      rhythms = arr.map(r => {
        const beats = Number.isFinite(r.beats) ? r.beats : 4;
        const beatUnit = Number.isFinite(r.beatUnit) ? r.beatUnit : 4;
        const division = Number.isFinite(r.division) ? r.division : 4;
        return {
          id: String(r.id || 'r-' + Date.now()),
          name: String(r.name || 'Без названия'),
          bpm: Number.isFinite(r.bpm) ? r.bpm : 100,
          beats,
          beatUnit,
          division,
          pattern: normalizePattern(r.pattern, beats, division),
        };
      });
    }
  } catch {}
}

function normalizePattern(raw, beats = 4, division = 4) {
  const total = beats * division;
  const p = emptyPattern(beats, division);
  if (!raw || typeof raw !== 'object') return p;
  // Legacy migration: earlier versions used 'crash' instead of 'ride'.
  // Treat the old key as if it were the new one.
  if (Array.isArray(raw.crash) && !Array.isArray(raw.ride)) raw.ride = raw.crash;
  for (const v of RHYTHM_VOICES) {
    const arr = raw[v.key];
    if (Array.isArray(arr)) {
      for (let i = 0; i < Math.min(total, arr.length); i++) p[v.key][i] = arr[i] ? 1 : 0;
    }
  }
  return p;
}

// Map an existing pattern to a new beats/division grid. Hits at positions
// that align with the new division survive; off-grid hits and hits in
// dropped beats are counted in `lostHits` so the caller can ask for
// confirmation before applying.
function resamplePattern(oldPattern, oldBeats, oldDiv, newBeats, newDiv) {
  const newPattern = emptyPattern(newBeats, newDiv);
  let lostHits = 0;
  for (const v of RHYTHM_VOICES) {
    const oldArr = oldPattern[v.key] || [];
    for (let i = 0; i < oldArr.length; i++) {
      if (!oldArr[i]) continue;
      const beat = Math.floor(i / oldDiv);
      if (beat >= newBeats) { lostHits++; continue; }
      const posInBeat = i % oldDiv;
      // Position within beat as fraction = posInBeat / oldDiv.
      // To survive, this fraction must be expressible as k / newDiv.
      const num = posInBeat * newDiv;
      if (num % oldDiv !== 0) { lostHits++; continue; }
      const newPos = num / oldDiv;
      newPattern[v.key][beat * newDiv + newPos] = 1;
    }
  }
  return { pattern: newPattern, lostHits };
}

function persistRhythms() {
  try { localStorage.setItem(RHYTHMS_KEY, JSON.stringify(rhythms)); } catch {}
}

function renderSavedRhythmsList() {
  const root = $('rhythms-saved-list');
  if (!root) return;
  root.innerHTML = '';
  for (const r of rhythms) {
    const row = document.createElement('div');
    row.className = 'rhythm-saved-row';
    const isActive = r.id === editorState.current;
    row.innerHTML = `
      <button class="rhythm-saved-load${isActive ? ' rhythm-saved-active' : ''}">
        <span class="rhythm-saved-name"></span>
        <span class="rhythm-saved-bpm"></span>
      </button>
      <button class="rhythm-saved-del" aria-label="Удалить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    `;
    row.querySelector('.rhythm-saved-name').textContent = r.name;
    row.querySelector('.rhythm-saved-bpm').textContent = `${r.bpm} BPM`;
    row.querySelector('.rhythm-saved-load').addEventListener('click', () => {
      loadRhythmIntoEditor(r.id);
      closeRhythmsSheet();
    });
    row.querySelector('.rhythm-saved-del').addEventListener('click', () => {
      if (confirm(`Удалить «${r.name}»?`)) deleteRhythm(r.id);
    });
    root.appendChild(row);
  }
}

function openRhythmsSheet() {
  $('rhythm-save-name').value = editorState.name || '';
  renderSavedRhythmsList();
  openModal('rhythms-modal');
}

function closeRhythmsSheet() {
  closeModal('rhythms-modal');
}

function loadRhythmIntoEditor(id) {
  const r = rhythms.find(x => x.id === id);
  if (!r) return;
  if (rhythmPlayer.active) stopRhythmPlayback();
  editorState.current = r.id;
  editorState.beats = r.beats || 4;
  editorState.beatUnit = r.beatUnit || 4;
  editorState.division = r.division || 4;
  editorState.pattern = normalizePattern(r.pattern, editorState.beats, editorState.division);
  editorState.bpm = r.bpm;
  editorState.name = r.name;
  $('rhythm-bpm').textContent = r.bpm;
  syncRhythmMetaUI();
  buildRhythmGrid();
}

function openRhythmEditor() {
  // Always opens "fresh" — empty pattern, default BPM, no current id.
  // To open a saved rhythm, use the bookmark icon → tap a saved row.
  if (rhythmPlayer.active) stopRhythmPlayback();
  editorState.current = null;
  editorState.beats = 4;
  editorState.beatUnit = 4;
  editorState.division = 4;
  editorState.pattern = emptyPattern(editorState.beats, editorState.division);
  editorState.bpm = 100;
  editorState.name = '';
  editorState.mode = 'with-drums';

  $('rhythm-bpm').textContent = editorState.bpm;
  syncRhythmModeUI();
  syncRhythmMetaUI();
  buildRhythmGrid();

  const el = $('rhythm-editor');
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  // Toggle a body-level flag so any modals opened on top of the rotated
  // editor can match the same rotation transform via CSS.
  document.body.classList.add('rhythm-editor-open');
}

function closeRhythmEditor() {
  if (rhythmPlayer.active) stopRhythmPlayback();
  const el = $('rhythm-editor');
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('rhythm-editor-open');
}

function buildRhythmGrid() {
  // Grid layout: (1 label + N cells) × 7 rows. Time runs LEFT-TO-RIGHT
  // in the landscape view; voice labels in the auto column on the left.
  // Cell count is dynamic = beats × division, set on the inline style so
  // CSS doesn't need to know the value.
  const grid = $('rhythm-grid');
  grid.innerHTML = '';
  const cells = rhythmCellCount();
  const div = editorState.division;
  grid.style.gridTemplateColumns = `auto repeat(${cells}, 1fr)`;
  for (const v of RHYTHM_VOICES) {
    const label = document.createElement('div');
    label.className = 'rhythm-voice-label';
    label.textContent = v.label;
    grid.appendChild(label);
    for (let i = 0; i < cells; i++) {
      const cell = document.createElement('button');
      cell.className = 'rhythm-cell';
      cell.dataset.voice = v.key;
      cell.dataset.cell = String(i);
      if (i % div === 0) cell.dataset.beat = 'true';
      if (editorState.pattern[v.key][i]) cell.classList.add('hit');
      cell.addEventListener('click', () => toggleRhythmCell(v.key, i, cell));
      grid.appendChild(cell);
    }
  }
}

function syncRhythmMetaUI() {
  const sigEl = $('rhythm-size-value');
  if (sigEl) sigEl.textContent = `${editorState.beats}/${editorState.beatUnit}`;
  const divEl = $('rhythm-division-value');
  if (divEl) {
    const def = DIVISIONS.find(d => d.value === editorState.division) || DIVISIONS[3];
    divEl.textContent = def.glyph;
  }
}

function toggleRhythmCell(voice, idx, cellEl) {
  const next = editorState.pattern[voice][idx] ? 0 : 1;
  editorState.pattern[voice][idx] = next;
  cellEl.classList.toggle('hit', !!next);
  // Tactile bump (Android only — iOS ignores)
  try { navigator.vibrate?.(6); } catch {}
}

function clearRhythmGrid() {
  for (const v of RHYTHM_VOICES) {
    editorState.pattern[v.key].fill(0);
  }
  document.querySelectorAll('.rhythm-cell.hit').forEach(c => c.classList.remove('hit'));
}

// --- Meter / division pickers ---

function openRhythmSizeSheet() {
  const root = $('rhythm-size-options');
  if (!root) return;
  root.innerHTML = '';
  for (const sig of TIME_SIGNATURES) {
    const btn = document.createElement('button');
    btn.className = 'rhythm-meter-option';
    if (sig.beats === editorState.beats && sig.unit === editorState.beatUnit) {
      btn.classList.add('is-active');
    }
    btn.textContent = `${sig.beats}/${sig.unit}`;
    btn.addEventListener('click', () => {
      closeModal('rhythm-size-modal');
      requestMeterChange(sig.beats, sig.unit);
    });
    root.appendChild(btn);
  }
  openModal('rhythm-size-modal');
}

function openRhythmDivisionSheet() {
  const root = $('rhythm-division-options');
  if (!root) return;
  root.innerHTML = '';
  const allowed = allowedDivisionsFor(editorState.beats);
  for (const def of DIVISIONS) {
    if (!allowed.includes(def.value)) continue;
    const btn = document.createElement('button');
    btn.className = 'rhythm-division-option';
    if (def.value === editorState.division) btn.classList.add('is-active');
    btn.innerHTML = `<span class="rhythm-division-glyph">${def.glyph}</span><span class="rhythm-division-name">${def.label}</span>`;
    btn.addEventListener('click', () => {
      closeModal('rhythm-division-modal');
      requestDivisionChange(def.value);
    });
    root.appendChild(btn);
  }
  openModal('rhythm-division-modal');
}

// Apply a meter (beats/unit) change. If switching to 12/8 with the
// current division forbidden there, downgrade division to the largest
// allowed value at the same time. Confirms with the user if the change
// would drop existing hits.
function requestMeterChange(newBeats, newUnit) {
  if (rhythmPlayer.active) stopRhythmPlayback();
  let targetDiv = editorState.division;
  const allowed = allowedDivisionsFor(newBeats);
  if (!allowed.includes(targetDiv)) targetDiv = Math.max(...allowed);
  if (newBeats === editorState.beats && newUnit === editorState.beatUnit && targetDiv === editorState.division) return;
  const { pattern, lostHits } = resamplePattern(
    editorState.pattern,
    editorState.beats, editorState.division,
    newBeats, targetDiv,
  );
  const apply = () => {
    editorState.beats = newBeats;
    editorState.beatUnit = newUnit;
    editorState.division = targetDiv;
    editorState.pattern = pattern;
    syncRhythmMetaUI();
    buildRhythmGrid();
  };
  if (lostHits > 0) {
    askMeterConfirm(`Действительно ли вы хотите изменить размер на ${newBeats}/${newUnit}? Часть выставленных ударов будет удалена.`, apply);
  } else {
    apply();
  }
}

function requestDivisionChange(newDiv) {
  if (rhythmPlayer.active) stopRhythmPlayback();
  if (newDiv === editorState.division) return;
  const { pattern, lostHits } = resamplePattern(
    editorState.pattern,
    editorState.beats, editorState.division,
    editorState.beats, newDiv,
  );
  const def = DIVISIONS.find(d => d.value === newDiv);
  const label = def ? def.label : '';
  const apply = () => {
    editorState.division = newDiv;
    editorState.pattern = pattern;
    syncRhythmMetaUI();
    buildRhythmGrid();
  };
  if (lostHits > 0) {
    askMeterConfirm(`Действительно ли вы хотите изменить деления на «${label}»? Часть выставленных ударов будет удалена.`, apply);
  } else {
    apply();
  }
}

function askMeterConfirm(text, onConfirm) {
  pendingMeterChange = onConfirm;
  $('rhythm-confirm-text').textContent = text;
  openModal('rhythm-confirm-modal');
}

function syncRhythmModeUI() {
  const btn = $('rhythm-mode');
  // aria-pressed="true" = drums on (lime), "false" = click-only (default).
  btn.setAttribute('aria-pressed', editorState.mode === 'with-drums' ? 'true' : 'false');
}

function toggleRhythmMode() {
  editorState.mode = editorState.mode === 'with-drums' ? 'click-only' : 'with-drums';
  syncRhythmModeUI();
}

function saveRhythm() {
  const name = ($('rhythm-save-name').value || '').trim() || 'Без названия';
  const bpm = Math.max(30, Math.min(320, Number($('rhythm-bpm').textContent) || 100));
  editorState.bpm = bpm;
  editorState.name = name;
  if (editorState.current) {
    const r = rhythms.find(r => r.id === editorState.current);
    if (r) {
      r.name = name;
      r.bpm = bpm;
      r.beats = editorState.beats;
      r.beatUnit = editorState.beatUnit;
      r.division = editorState.division;
      r.pattern = normalizePattern(editorState.pattern, editorState.beats, editorState.division);
    }
  } else {
    const id = 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    rhythms.push({
      id, name, bpm,
      beats: editorState.beats,
      beatUnit: editorState.beatUnit,
      division: editorState.division,
      pattern: normalizePattern(editorState.pattern, editorState.beats, editorState.division),
    });
    editorState.current = id;
  }
  persistRhythms();
  renderSavedRhythmsList();
  showToast('Сохранено');
}

function deleteRhythm(id) {
  rhythms = rhythms.filter(r => r.id !== id);
  // If we just deleted the one being edited, drop the link so a future
  // save creates a new entry rather than trying to update a deleted id.
  if (editorState.current === id) editorState.current = null;
  persistRhythms();
  renderSavedRhythmsList();
}

// --- Drum voice synthesis ---
// Each voice gets a distinct timbre. Noise-based for crash/hat/snare,
// pitched oscillators for toms/kick. Built on top of the same audioCtx
// that the metronome uses, so user volume / mute / mute-bar settings
// don't apply here (the editor is its own playback context).

let rhythmNoiseBuffer = null;
function getRhythmNoise() {
  if (rhythmNoiseBuffer) return rhythmNoiseBuffer;
  const len = Math.floor(audioCtx.sampleRate * 1);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  rhythmNoiseBuffer = buf;
  return buf;
}

function playNoiseHit(time, opts) {
  const { decay, hpFreq, lpFreq, gain } = opts;
  const src = audioCtx.createBufferSource();
  src.buffer = getRhythmNoise();
  let node = src;
  if (hpFreq) {
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = hpFreq;
    node.connect(hp);
    node = hp;
  }
  if (lpFreq) {
    const lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lpFreq;
    node.connect(lp);
    node = lp;
  }
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  node.connect(g).connect(audioCtx.destination);
  src.start(time);
  src.stop(time + decay + 0.05);
}

function playPitchedHit(time, opts) {
  const { freq, freqEnd, decay, gain, type = 'sine' } = opts;
  const osc = audioCtx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  if (freqEnd != null) {
    osc.frequency.exponentialRampToValueAtTime(freqEnd, time + decay * 0.6);
  }
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(gain, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(time);
  osc.stop(time + decay + 0.05);
}

function playDrumVoice(voice, time) {
  if (!audioCtx) return;
  switch (voice) {
    case 'ride':
      // Ride cymbal: shorter than crash, with a clearer fundamental ping
      // and metallic overtones layered on top.
      playNoiseHit(time, { decay: 0.5, hpFreq: 5500, gain: 0.22 });
      playPitchedHit(time, { freq: 1500, decay: 0.5, gain: 0.1, type: 'square' });
      playPitchedHit(time, { freq: 2200, decay: 0.4, gain: 0.06, type: 'square' });
      break;
    case 'hat':   playNoiseHit(time, { decay: 0.06, hpFreq: 7000, gain: 0.3 }); break;
    case 'snare':
      playNoiseHit(time, { decay: 0.16, hpFreq: 1500, gain: 0.4 });
      playPitchedHit(time, { freq: 220, decay: 0.1, gain: 0.25, type: 'triangle' });
      break;
    case 'tom1':  playPitchedHit(time, { freq: 280, freqEnd: 220, decay: 0.3, gain: 0.55, type: 'sine' }); break;
    case 'tom2':  playPitchedHit(time, { freq: 180, freqEnd: 140, decay: 0.35, gain: 0.6, type: 'sine' }); break;
    case 'tom3':  playPitchedHit(time, { freq: 110, freqEnd: 80,  decay: 0.4,  gain: 0.65, type: 'sine' }); break;
    case 'kick':  playPitchedHit(time, { freq: 150, freqEnd: 45,  decay: 0.16, gain: 0.85, type: 'sine' }); break;
  }
}

// --- Editor playback scheduler ---
//
// 16th-note cell scheduler with look-ahead, similar in spirit to the main
// metronome. Each tick:
//   - if cellIdx % 4 === 0, play metronome click (accent on cell 0, beat
//     otherwise) — always, in both modes
//   - if mode === 'with-drums', play any voices marked at this cell
//   - queue a visual highlight cue
async function startRhythmPlayback() {
  await ensureAudio();
  if (audioCtx.state !== 'running') return;
  rhythmPlayer.active = true;
  rhythmPlayer.cellIdx = 0;
  rhythmPlayer.nextTime = audioCtx.currentTime + 0.08;
  rhythmPlayer.cues = [];
  rhythmTickScheduler();
  rhythmVisualLoop();
  $('rhythm-play').classList.add('playing');
  $('rhythm-play').querySelector('.rhythm-play-icon').textContent = '■';
}

function stopRhythmPlayback() {
  rhythmPlayer.active = false;
  if (rhythmPlayer.schedTimer) { clearTimeout(rhythmPlayer.schedTimer); rhythmPlayer.schedTimer = null; }
  if (rhythmPlayer.rafId) { cancelAnimationFrame(rhythmPlayer.rafId); rhythmPlayer.rafId = 0; }
  rhythmPlayer.cues = [];
  clearRhythmCursor();
  $('rhythm-play').classList.remove('playing');
  $('rhythm-play').querySelector('.rhythm-play-icon').textContent = '▶';
}

function rhythmTickScheduler() {
  if (!rhythmPlayer.active) return;
  const SCHED_AHEAD = 0.1;
  const cells = rhythmCellCount();
  const div = editorState.division;
  while (rhythmPlayer.nextTime < audioCtx.currentTime + SCHED_AHEAD) {
    const idx = rhythmPlayer.cellIdx % cells;
    const t = rhythmPlayer.nextTime;
    if (editorState.mode === 'with-drums') {
      // Listening to the pattern — drum voices only, no metronome click
      // (click would mask the groove).
      for (const v of RHYTHM_VOICES) {
        if (editorState.pattern[v.key][idx]) playDrumVoice(v.key, t);
      }
    } else {
      // Practicing — only the metronome click on each beat (every
      // `division` cells), drums are silent so the user plays them.
      if (idx % div === 0) {
        const beatType = idx === 0 ? 'accent' : 'beat';
        playClick(beatType, t);
      }
    }
    rhythmPlayer.cues.push({ cellIdx: idx, time: t });
    const secPerCell = (60.0 / editorState.bpm) / div;
    rhythmPlayer.nextTime += secPerCell;
    rhythmPlayer.cellIdx++;
  }
  rhythmPlayer.schedTimer = setTimeout(rhythmTickScheduler, 25);
}

function rhythmVisualLoop() {
  if (!rhythmPlayer.active) return;
  const now = audioCtx.currentTime;
  // Promote the latest cue whose time has passed
  while (rhythmPlayer.cues.length && rhythmPlayer.cues[0].time <= now) {
    const cue = rhythmPlayer.cues.shift();
    setRhythmCursor(cue.cellIdx);
  }
  rhythmPlayer.rafId = requestAnimationFrame(rhythmVisualLoop);
}

function setRhythmCursor(cellIdx) {
  if (rhythmPlayer.highlightedCell === cellIdx) return;
  clearRhythmCursor();
  document.querySelectorAll(`.rhythm-cell[data-cell="${cellIdx}"]`)
    .forEach(c => c.classList.add('playing'));
  rhythmPlayer.highlightedCell = cellIdx;
}

function clearRhythmCursor() {
  document.querySelectorAll('.rhythm-cell.playing').forEach(c => c.classList.remove('playing'));
  rhythmPlayer.highlightedCell = -1;
}

function toggleRhythmPlay() {
  if (rhythmPlayer.active) stopRhythmPlayback();
  else startRhythmPlayback();
}

// --- Init ---

function init() {
  // Restore persisted BT latency settings before bind() reads them
  const storedBt = parseInt(localStorage.getItem(BT_LATENCY_KEY) || '0', 10);
  if (Number.isFinite(storedBt)) state.btLatencyMs = storedBt;
  const storedAuto = localStorage.getItem(BT_AUTO_KEY);
  if (storedAuto !== null) state.autoBtLatency = storedAuto === '1';

  // Apply persisted theme (the inline <head> script already set data-theme to
  // avoid flash; this syncs the meta tag and the picker's active state).
  applyTheme(loadTheme());

  // Restore persisted sound choices
  const storedAccent = localStorage.getItem(SOUND_ACCENT_KEY);
  if (storedAccent && SOUND_TYPES[storedAccent]) state.soundAccent = storedAccent;
  const storedBeat = localStorage.getItem(SOUND_BEAT_KEY);
  if (storedBeat && SOUND_TYPES[storedBeat]) state.soundBeat = storedBeat;

  bind();

  // Apply BT latency UI state after binding
  $('bt-auto').checked = state.autoBtLatency;
  updateBtLatencyUI();

  buildTimeGrid();
  rebuildBeatIndicator();
  renderBuiltinPresets();
  renderUserPresets();
  syncProgramPickerUI();
  loadUserPrograms();
  renderUserPrograms();
  loadRhythms();
  updateSubDisplay();
  updateTimeDisplay();
  updatePlayButton();
  updateCountinUI();
  updateSoundPickerUI();
  setupVersionAndUpdate();
  handleImportDeeplink();
  // Wheel must build after layout settles so clientWidth is correct
  requestAnimationFrame(buildBpmWheel);
}

// If the page was opened with ?import=<base64>, parse it and show the
// confirm sheet so the user can preview and save the program.
// Replaces the URL afterward so a refresh doesn't re-trigger.
function handleImportDeeplink() {
  try {
    const params = new URLSearchParams(location.search);
    const param = params.get('import');
    if (!param) return;
    let pkg;
    try {
      pkg = decodeBase64Json(param);
      validateProgram(pkg);
    } catch (e) {
      showToast(`Не удалось импортировать: ${e.message || 'формат повреждён'}`);
      history.replaceState({}, '', location.pathname);
      return;
    }
    history.replaceState({}, '', location.pathname);
    // Switch to Тренировки tab so the user sees what they're importing
    // into.
    switchTab('training');
    showImportConfirm(pkg);
  } catch {}
}

init();
