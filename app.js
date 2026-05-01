// Metronome — Web Audio API scheduler with lookahead.
// Reference: Chris Wilson, "A Tale of Two Clocks".

const APP_VERSION = '1.3.0';

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

  // Bluetooth output latency (ms). Visual indicator is delayed by this much
  // so the flash matches when the click actually arrives in the listener's ear.
  btLatencyMs: 0,
  // When true, pull the value from audioCtx.outputLatency on each start();
  // when false, the manual slider is canonical.
  autoBtLatency: true,
};

const BT_LATENCY_KEY = 'metronome.bt-latency-ms';
const BT_AUTO_KEY = 'metronome.bt-auto';

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
  clearBeatIndicator();
  updatePlayButton();
  releaseWakeLock();
}

function toggle() {
  if (state.isPlaying) stop(); else start();
}

// --- Visual sync ---

function draw() {
  if (!state.isPlaying) return;
  const now = audioCtx.currentTime;
  // Delay visual flash by btLatencyMs so it lines up with what the listener
  // actually hears through their (potentially Bluetooth) headphones.
  const visualOffset = state.btLatencyMs / 1000;
  while (notesInQueue.length && notesInQueue[0].time + visualOffset <= now) {
    const n = notesInQueue.shift();
    if (n.sub === 0) highlightBeat(n.beat);
  }
  requestAnimationFrame(draw);
}

function highlightBeat(beat) {
  document.querySelectorAll('.beat-stack').forEach((s, i) => {
    s.classList.toggle('active', i === beat);
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
  if (state.beatTypes[0] === 'mute' || state.beatTypes[0] === 'soft') {
    // first beat defaults to accent if newly resized; leave alone if user set it
  }

  const el = $('beat-indicator');
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
  const stack = document.querySelector(`.beat-stack[data-beat="${i}"]`);
  if (stack) {
    stack.dataset.type = next;
    stack.setAttribute('aria-label', `Доля ${i + 1}: ${next}`);
  }
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
  document.querySelectorAll('.sub-option').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.sub) === state.subdivision);
  });
}

function updateTimeDisplay() {
  $('time-num-out').textContent = state.beatsPerMeasure;
  $('time-den-out').textContent = state.beatUnit;
  $('time-num').value = state.beatsPerMeasure;
  $('time-den').value = state.beatUnit;
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

function applyPreset(p) {
  setBpm(p.bpm);
  state.beatsPerMeasure = p.num;
  state.beatUnit = p.den;
  state.subdivision = p.sub;
  state.currentBeat = 0;
  state.currentSub = 0;
  rebuildBeatIndicator();
  updateSubDisplay();
  updateTimeDisplay();
}

function renderBuiltinPresets() {
  const root = $('builtin-presets');
  root.innerHTML = '';
  BUILTIN_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.className = 'preset';
    b.textContent = p.name;
    b.addEventListener('click', () => applyPreset(p));
    root.appendChild(b);
  });
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
    const wrap = document.createElement('div');
    wrap.className = 'preset-row';
    const b = document.createElement('button');
    b.className = 'preset';
    b.textContent = `${p.name} · ${p.bpm} BPM`;
    b.addEventListener('click', () => applyPreset(p));
    const del = document.createElement('button');
    del.className = 'preset-del';
    del.textContent = '✕';
    del.title = 'Удалить пресет';
    del.addEventListener('click', () => {
      const list2 = loadUserPresets();
      list2.splice(idx, 1);
      saveUserPresets(list2);
      renderUserPresets();
    });
    wrap.append(b, del);
    root.appendChild(wrap);
  });
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

  // Modal backdrops
  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => {
      const modal = el.closest('.modal');
      if (modal) closeModal(modal.id);
    });
  });

  // Drawer's detailed time selectors (legacy fallback inside drawer)
  $('time-num').addEventListener('change', e => {
    state.beatsPerMeasure = Number(e.target.value);
    state.currentBeat = 0;
    rebuildBeatIndicator();
    updateTimeDisplay();
  });
  $('time-den').addEventListener('change', e => {
    state.beatUnit = Number(e.target.value);
    updateTimeDisplay();
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

// --- Init ---

function init() {
  // Restore persisted BT latency settings before bind() reads them
  const storedBt = parseInt(localStorage.getItem(BT_LATENCY_KEY) || '0', 10);
  if (Number.isFinite(storedBt)) state.btLatencyMs = storedBt;
  const storedAuto = localStorage.getItem(BT_AUTO_KEY);
  if (storedAuto !== null) state.autoBtLatency = storedAuto === '1';

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
