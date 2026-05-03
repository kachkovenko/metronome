// Metronome — Web Audio API scheduler with lookahead.
// Reference: Chris Wilson, "A Tale of Two Clocks".

const APP_VERSION = '1.8.2';

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

  volMaster: 0.7,
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
  mutePct: 20,

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
};

const BT_LATENCY_KEY = 'metronome.bt-latency-ms';
const BT_AUTO_KEY = 'metronome.bt-auto';
const INPUT_LATENCY_KEY = 'metronome.input-latency-ms';
const THEME_KEY = 'metronome.theme';
const FLASH_WARNING_KEY = 'metronome.flash-warning-acked';

const THEME_COLORS = { dark: '#000000', light: '#f5f5f7' };

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

  let freq, vol, dur;
  if (type === 'accent')      { freq = 1500; vol = state.volAccent;       dur = 0.05; }
  else if (type === 'beat')   { freq = 900;  vol = state.volBeat;         dur = 0.05; }
  else if (type === 'soft')   { freq = 700;  vol = state.volBeat * 0.5;   dur = 0.04; }
  else                        { freq = 600;  vol = state.volSub;          dur = 0.03; }

  osc.type = 'square';
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

  if (sub === 0) {
    const beatType = state.beatTypes[beat] || 'beat';
    if (beatType === 'mute') return;
    if (state.muteEnabled && Math.random() * 100 < state.mutePct) return;
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
  nextNoteTime = audioCtx.currentTime + 0.05;
  scheduler();
  requestAnimationFrame(draw);
  updatePlayButton();
  requestWakeLock();
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
  document.querySelectorAll('.beat-stack').forEach(s => {
    s.classList.toggle('active', Number(s.dataset.beat) === beat);
  });
  if (state.flashEnabled) triggerFlash(beat);
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
const BPM_MAX = 300;
const TICK_PX = 10;  // tick (2px) + gap (8px) per BPM step
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
  applyWheelPadding();
  scrollWheelToBpm(state.bpm, false);
}

function applyWheelPadding() {
  const wheel = $('bpm-wheel');
  const track = $('wheel-track');
  const halfW = wheel.clientWidth / 2;
  track.style.paddingLeft = halfW + 'px';
  track.style.paddingRight = halfW + 'px';
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
  const wheel = $('bpm-wheel');
  const idx = Math.round(wheel.scrollLeft / TICK_PX);
  const bpm = Math.max(BPM_MIN, Math.min(BPM_MAX, BPM_MIN + idx));
  if (bpm !== state.bpm) {
    state.bpm = bpm;
    $('bpm-input').value = bpm;
    wheel.setAttribute('aria-valuenow', String(bpm));
  }
  // Snap to exact tick after scroll settles
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
  const cin = $('countin-btn');
  if (cin) cin.disabled = state.isPlaying || state.countinActive;
  // Sync the in-fullscreen Start/Stop button (icon-only)
  const flashPlay = $('flash-play');
  if (flashPlay) {
    flashPlay.classList.toggle('playing', state.isPlaying);
    flashPlay.querySelector('.flash-play-icon').textContent = state.isPlaying ? '■' : '▶';
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
  // Show "in development" notice every time the user opens Training (the tab
  // is currently a placeholder; the modal will go away once content lands).
  if (tabId === 'training') openModal('training-modal');
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

  // Fullscreen flash view
  $('fullscreen-btn').addEventListener('click', openFlashScreen);
  $('flash-close').addEventListener('click', closeFlashScreen);
  $('flash-lamp').addEventListener('click', tryToggleLamp);
  $('flash-play').addEventListener('click', toggle);

  // Training tab placeholder
  $('training-ok').addEventListener('click', () => closeModal('training-modal'));

  // Epilepsy warning modal
  $('flash-warning-cancel').addEventListener('click', () => closeModal('flash-warning-modal'));
  $('flash-warning-ok').addEventListener('click', () => {
    if ($('flash-warning-skip').checked) {
      try { localStorage.setItem(FLASH_WARNING_KEY, '1'); } catch {}
    }
    closeModal('flash-warning-modal');
    setFlashMode(true);
  });

  // Count-in (delayed start)
  $('countin-btn').addEventListener('click', () => {
    if (state.isPlaying || state.countinActive) return;
    openModal('countin-modal');
  });
  document.querySelectorAll('.countin-option').forEach(b => {
    b.addEventListener('click', () => {
      const sec = Number(b.dataset.sec);
      closeModal('countin-modal');
      startCountin(sec);
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
  $('trainer-on').addEventListener('change', e => state.trainerEnabled = e.target.checked);
  $('trainer-start').addEventListener('change', e => state.trainerStart = Number(e.target.value));
  $('trainer-end').addEventListener('change', e => state.trainerEnd = Number(e.target.value));
  $('trainer-step').addEventListener('change', e => state.trainerStep = Number(e.target.value));
  $('trainer-bars').addEventListener('change', e => state.trainerBars = Number(e.target.value));

  // Mute
  $('mute-on').addEventListener('change', e => state.muteEnabled = e.target.checked);
  $('mute-pct').addEventListener('input', e => {
    state.mutePct = Number(e.target.value);
    $('mute-pct-out').value = state.mutePct;
  });

  // Mic timing trainer
  $('mic-on').addEventListener('change', async e => {
    if (e.target.checked) {
      if (state.isPlaying) {
        e.target.checked = false;
        setMicStatus('Останови метроном перед включением — нужно прогнать тестовый клик и проверить, не идёт ли звук через динамик.');
        showToast('Сначала останови метроном');
        return;
      }
      await startMic();
    } else {
      stopMic();
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

  // Sessions / walkthrough
  $('walk-close').addEventListener('click', closeWalkthrough);
  $('walk-next').addEventListener('click', () => walkStep(+1));
  $('walk-prev').addEventListener('click', () => walkStep(-1));
  $('walk-bpm-up').addEventListener('click', () => walkBpm(+5));
  $('walk-bpm-down').addEventListener('click', () => walkBpm(-5));

  // Presets
  $('preset-save').addEventListener('click', saveCurrentAsPreset);

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
      closeModal('flash-warning-modal');
      closeModal('training-modal');
      if ($('flash-screen').classList.contains('open')) closeFlashScreen();
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

// --- Sessions / training walkthrough ---

const SESSION_FILES = ['./sessions/drum-beginner-session.json'];
let availableSessions = [];
let walk = null;            // { session, exercises[], idx, exercise, timerEnd, timerInterval }

async function loadSessions() {
  const results = await Promise.all(SESSION_FILES.map(f =>
    fetch(f).then(r => r.ok ? r.json() : null).catch(() => null)
  ));
  availableSessions = results.filter(Boolean);
  renderSessionsList();
}

function renderSessionsList() {
  const root = $('sessions-list');
  if (!root) return;
  root.innerHTML = '';
  if (!availableSessions.length) {
    root.innerHTML = '<p class="muted">Тренировки не найдены.</p>';
    return;
  }
  availableSessions.forEach(s => {
    const card = document.createElement('button');
    card.className = 'session-card';
    const blocksHtml = s.blocks.map(b =>
      `<span>${b.title} · ${b.subtitle}</span>`
    ).join('');
    card.innerHTML = `
      <div class="session-card-title">${s.title}</div>
      <div class="session-card-sub">${s.subtitle}</div>
      <div class="session-card-blocks">${blocksHtml}</div>
    `;
    card.addEventListener('click', () => startWalkthrough(s));
    root.appendChild(card);
  });
}

function showFullscreen(id) {
  const el = $(id);
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
}

function hideFullscreen(id) {
  const el = $(id);
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

function flattenSession(s) {
  return s.blocks.flatMap((b, bi) =>
    b.exercises.map((ex, ei) => ({
      ...ex,
      blockIdx: bi,
      blockTitle: b.title,
      blockSubtitle: b.subtitle,
      indexInBlock: ei,
      totalInBlock: b.exercises.length,
    }))
  );
}

function startWalkthrough(session) {
  walk = {
    session,
    exercises: flattenSession(session),
    idx: 0,
    exercise: null,
    timerEnd: 0,
    timerInterval: null,
  };
  showFullscreen('walk-screen');
  renderExercise();
}

function closeWalkthrough() {
  if (walk?.timerInterval) clearInterval(walk.timerInterval);
  walk = null;
  if (state.isPlaying) stop();
  hideFullscreen('walk-screen');
}

function walkStep(delta) {
  if (!walk) return;
  const next = walk.idx + delta;
  if (next < 0) return;
  if (next >= walk.exercises.length) {
    showToast('Сессия завершена. Молодец!');
    closeWalkthrough();
    return;
  }
  walk.idx = next;
  renderExercise();
}

function walkBpm(delta) {
  if (!walk) return;
  setBpm(state.bpm + delta);
  $('walk-bpm').textContent = state.bpm;
}

function renderExercise() {
  const ex = walk.exercises[walk.idx];
  walk.exercise = ex;

  $('walk-block-name').textContent = ex.blockTitle;
  $('walk-step-info').textContent =
    `${ex.indexInBlock + 1} / ${ex.totalInBlock} · упр. ${walk.idx + 1} из ${walk.exercises.length}`;

  $('walk-title').textContent = ex.title;
  $('walk-instructions').textContent = ex.instructions || '';
  $('walk-tip').textContent = ex.tip || '';

  // Sticking
  const stickEl = $('walk-sticking');
  stickEl.textContent = ex.sticking || '';

  // Apply metronome state if it's a metronome exercise (not free-play)
  if (!ex.freePlay) {
    if (typeof ex.bpm === 'number') setBpm(ex.bpm);
    if (Array.isArray(ex.timeSig)) {
      state.beatsPerMeasure = ex.timeSig[0];
      state.beatUnit = ex.timeSig[1];
      state.currentBeat = 0;
      rebuildBeatIndicator();
      updateTimeDisplay();
    }
    if (typeof ex.subdivision === 'number') {
      state.subdivision = ex.subdivision;
      state.currentSub = 0;
      updateSubDisplay();
    }
    if (Array.isArray(ex.beats)) {
      state.beatTypes = ex.beats.slice(0, state.beatsPerMeasure);
      while (state.beatTypes.length < state.beatsPerMeasure) state.beatTypes.push('beat');
      rebuildBeatIndicator();
    }
    // Auto-start metronome if not already playing
    if (!state.isPlaying) start();
    $('walk-bpm').textContent = state.bpm;
    $('walk-timesig').textContent = `${state.beatsPerMeasure} / ${state.beatUnit}`;
    $('walk-sub').textContent = SUB_META[state.subdivision]?.symbol || '♩';
  } else {
    // Free play — stop metronome
    if (state.isPlaying) stop();
    $('walk-bpm').textContent = '—';
    $('walk-timesig').textContent = '—';
    $('walk-sub').textContent = '—';
  }

  // Groove notation
  renderGroove(ex.groove || null);

  // Timer
  startWalkTimer(ex.durationSec || 0);
}

function renderGroove(groove) {
  const root = $('walk-groove');
  root.innerHTML = '';
  if (!groove) return;

  const cols = groove.labels.length;
  // gridColumn: label column + N data columns
  const grid = document.createElement('div');
  grid.className = 'groove-grid';

  // Header row: empty + numeric labels
  const headerRow = document.createElement('div');
  headerRow.className = 'groove-row';
  headerRow.style.gridTemplateColumns = `60px repeat(${cols}, 1fr)`;
  const empty = document.createElement('div');
  empty.className = 'groove-cell label';
  headerRow.appendChild(empty);
  groove.labels.forEach(lbl => {
    const c = document.createElement('div');
    c.className = 'groove-cell head' + (/^\d/.test(lbl) ? ' head-num' : '');
    c.textContent = lbl;
    headerRow.appendChild(c);
  });
  grid.appendChild(headerRow);

  // Data rows
  groove.rows.forEach(row => {
    const r = document.createElement('div');
    r.className = 'groove-row';
    r.style.gridTemplateColumns = `60px repeat(${cols}, 1fr)`;
    const lbl = document.createElement('div');
    lbl.className = 'groove-cell label';
    lbl.textContent = row.name;
    r.appendChild(lbl);
    row.hits.forEach(h => {
      const c = document.createElement('div');
      c.className = 'groove-cell';
      if (h === 'x') c.innerHTML = '<span class="groove-mark x">×</span>';
      else if (h === 'o') c.innerHTML = '<span class="groove-mark o"></span>';
      r.appendChild(c);
    });
    grid.appendChild(r);
  });

  root.appendChild(grid);
}

function startWalkTimer(durationSec) {
  if (walk.timerInterval) {
    clearInterval(walk.timerInterval);
    walk.timerInterval = null;
  }
  if (!durationSec) {
    $('walk-timer-text').textContent = '—';
    $('walk-timer-fill').style.width = '0%';
    return;
  }
  walk.timerEnd = Date.now() + durationSec * 1000;
  const total = durationSec;
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((walk.timerEnd - Date.now()) / 1000));
    const elapsed = total - remaining;
    const pct = Math.min(100, Math.max(0, (elapsed / total) * 100));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    $('walk-timer-text').textContent = `${m}:${String(s).padStart(2, '0')}`;
    $('walk-timer-fill').style.width = pct + '%';
    if (remaining <= 0) {
      clearInterval(walk.timerInterval);
      walk.timerInterval = null;
      showToast('Время вышло. Можно идти дальше.');
    }
  };
  tick();
  walk.timerInterval = setInterval(tick, 250);
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
}

function tryToggleLamp() {
  if (state.flashEnabled) { setFlashMode(false); return; }
  // First-time activation — show epilepsy warning unless previously acked
  let acked = false;
  try { acked = localStorage.getItem(FLASH_WARNING_KEY) === '1'; } catch {}
  if (acked) { setFlashMode(true); return; }
  openModal('flash-warning-modal');
}

// Fired from highlightBeat() when state.flashEnabled is true.
// Mitigations per WCAG 2.3.1: low peak opacity, fast fade, accent gets
// full screen but it's the rarer beat; non-accent gets only top half with
// even lower contrast.
function triggerFlash(beat) {
  const beatType = state.beatTypes[beat] || 'beat';
  if (beatType === 'mute') return;
  const isAccent = beatType === 'accent';
  const overlay = isAccent ? $('flash-overlay-full') : $('flash-overlay-half');
  if (!overlay) return;
  const cls = isAccent ? 'flash-pulse-full' : 'flash-pulse-half';
  // Restart animation by toggling class
  overlay.classList.remove(cls);
  void overlay.offsetWidth;
  overlay.classList.add(cls);
}

// --- Count-in (delayed start) ---

const COUNTIN_OPTIONS = [3, 5, 7, 10];

async function startCountin(sec) {
  if (state.isPlaying || state.countinActive) return;
  state.countinActive = true;
  state.countinSec = sec;

  const overlay = $('countin-overlay');
  const num = $('countin-num');
  let remaining = sec;
  num.textContent = remaining;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  $('countin-btn')?.classList.add('armed');

  // Kick off the metronome — clicks will be audible throughout the countdown,
  // and after the overlay disappears the same scheduler keeps running, so
  // there's no perceptible "switch" between count-in and the real start.
  try { await start(); } catch {}
  // Bail out if start() failed (no audio) or the user already pressed Stop
  if (!state.isPlaying || !state.countinActive) {
    finishCountin();
    return;
  }

  state.countinTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      finishCountin();
    } else {
      num.textContent = remaining;
    }
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
  $('countin-btn')?.classList.remove('armed');
}

function cancelCountin() {
  // Called from stop() when user aborts during countdown
  finishCountin();
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

  bind();

  // Apply BT latency UI state after binding
  $('bt-auto').checked = state.autoBtLatency;
  updateBtLatencyUI();

  buildTimeGrid();
  rebuildBeatIndicator();
  renderBuiltinPresets();
  renderUserPresets();
  updateSubDisplay();
  updateTimeDisplay();
  updatePlayButton();
  setupVersionAndUpdate();
  loadSessions();
  // Wheel must build after layout settles so clientWidth is correct
  requestAnimationFrame(buildBpmWheel);
}

init();
