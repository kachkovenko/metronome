// Metronome — Web Audio API scheduler with lookahead.
// Reference: Chris Wilson, "A Tale of Two Clocks".

const APP_VERSION = '1.0.2';

const state = {
  bpm: 100,
  beatsPerMeasure: 4,
  beatUnit: 4,
  subdivision: 1,
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
};

let audioCtx = null;
let silentAudio = null;
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
  if (type === 'accent') { freq = 1500; vol = state.volAccent; dur = 0.05; }
  else if (type === 'beat') { freq = 900; vol = state.volBeat; dur = 0.05; }
  else { freq = 600; vol = state.volSub; dur = 0.03; }

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

  let type;
  if (sub === 0) type = (beat === 0) ? 'accent' : 'beat';
  else type = 'sub';

  if (state.muteEnabled && sub === 0 && Math.random() * 100 < state.mutePct) {
    return;
  }
  playClick(type, time);
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
  if (state.trainerEnabled) setBpm(state.trainerStart);
  state.isPlaying = true;
  state.currentBeat = 0;
  state.currentSub = 0;
  state.trainerBarCount = 0;
  nextNoteTime = audioCtx.currentTime + 0.05;
  scheduler();
  requestAnimationFrame(draw);
  updatePlayButton();
}

function stop() {
  state.isPlaying = false;
  clearTimeout(timerID);
  notesInQueue.length = 0;
  clearBeatIndicator();
  updatePlayButton();
}

function toggle() {
  if (state.isPlaying) stop(); else start();
}

// --- Visual sync ---

function draw() {
  if (!state.isPlaying) return;
  const now = audioCtx.currentTime;
  while (notesInQueue.length && notesInQueue[0].time <= now) {
    const n = notesInQueue.shift();
    if (n.sub === 0) highlightBeat(n.beat);
  }
  requestAnimationFrame(draw);
}

function highlightBeat(beat) {
  const dots = document.querySelectorAll('#beat-indicator .dot');
  dots.forEach((d, i) => d.classList.toggle('active', i === beat));
}

function clearBeatIndicator() {
  document.querySelectorAll('#beat-indicator .dot').forEach(d => d.classList.remove('active'));
}

function rebuildBeatIndicator() {
  const el = $('beat-indicator');
  el.innerHTML = '';
  for (let i = 0; i < state.beatsPerMeasure; i++) {
    const dot = document.createElement('div');
    dot.className = 'dot' + (i === 0 ? ' accent' : '');
    el.appendChild(dot);
  }
}

// --- Display updaters ---

function setBpm(v) {
  v = Math.max(30, Math.min(300, Math.round(v)));
  state.bpm = v;
  $('bpm-input').value = v;
  $('bpm-slider').value = v;
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

// --- Drawer + modals ---

function openDrawer() {
  $('drawer').classList.add('open');
  $('drawer').setAttribute('aria-hidden', 'false');
  $('drawer-backdrop').hidden = false;
  requestAnimationFrame(() => $('drawer-backdrop').classList.add('show'));
}

function closeDrawer() {
  $('drawer').classList.remove('open');
  $('drawer').setAttribute('aria-hidden', 'true');
  const bd = $('drawer-backdrop');
  bd.classList.remove('show');
  setTimeout(() => { bd.hidden = true; }, 280);
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
  $('bpm-slider').addEventListener('input', e => setBpm(Number(e.target.value)));
  document.querySelectorAll('.bpm-step').forEach(b => {
    b.addEventListener('click', () => setBpm(state.bpm + Number(b.dataset.delta)));
  });

  $('tap-btn').addEventListener('click', tap);
  $('play-btn').addEventListener('click', toggle);

  // Drawer
  $('menu-btn').addEventListener('click', openDrawer);
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-backdrop').addEventListener('click', closeDrawer);

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

  // Presets
  $('preset-save').addEventListener('click', saveCurrentAsPreset);

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'KeyT') { e.preventDefault(); tap(); }
    else if (e.code === 'Escape') {
      closeDrawer();
      closeModal('sub-modal');
      closeModal('time-modal');
    }
  });

  document.addEventListener('gesturestart', e => e.preventDefault());
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

// --- Init ---

function init() {
  bind();
  buildTimeGrid();
  rebuildBeatIndicator();
  renderBuiltinPresets();
  renderUserPresets();
  updateSubDisplay();
  updateTimeDisplay();
  updatePlayButton();
  setupVersionAndUpdate();
}

init();
