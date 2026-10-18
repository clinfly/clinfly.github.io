// Uygulama: ekranlar, ayarlar ve oyun döngüsü
import { InputManager } from './input/InputManager.js';
import { MicInput } from './input/MicInput.js';
import { MidiInput } from './input/MidiInput.js';
import { TouchInput } from './input/TouchInput.js';
import { LIBRARY, loadSong, importSongFile } from './song.js';
import { Game } from './game.js';
import { Renderer } from './renderer.js';
import { midiToName, LOW_MIDI, HIGH_MIDI } from './notes.js';

const $ = (sel) => document.querySelector(sel);

// ---------- Ayarlar (cihazda saklanır) ----------
const DEFAULTS = { sensitivity: 60, octaveTolerant: false, hands: 'R', speed: '0.75', wait: true };
const settings = { ...DEFAULTS, ...readJSON('piano.settings') };
function saveSettings() {
  try { localStorage.setItem('piano.settings', JSON.stringify(settings)); } catch { /* yok say */ }
}
function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

// ---------- Giriş katmanı ----------
const input = new InputManager();
const mic = input.add('mic', new MicInput());
const touch = input.add('touch', new TouchInput());
const midiIn = input.add('midi', new MidiInput());
mic.setSensitivity(settings.sensitivity);

async function ensureMic() {
  if (mic.running) return true;
  try {
    await mic.start();
    return true;
  } catch (err) {
    console.error(err);
    const msg = !window.isSecureContext
      ? 'Mikrofon için sayfa HTTPS ile açılmalı.'
      : err.name === 'NotAllowedError'
        ? 'Mikrofon izni verilmedi. Ayarlar › Safari › Mikrofon bölümünden izin ver.'
        : 'Mikrofon açılamadı: ' + err.message;
    toast(msg, 5000);
    return false;
  }
}

// ---------- Ekran yönetimi ----------
let current = 'home';
function go(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === name));
  const prev = current;
  current = name;
  if (prev === 'play' && name !== 'play') stopGame();
  if (name === 'home') renderLibrary();
  if (name === 'tuner') enterTuner();
  if (name === 'settings') enterSettings();
  $('#rotate').classList.toggle('need', name === 'play');
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-go]');
  if (t) go(t.dataset.go);
});
$('#rotate-dismiss').onclick = () => document.body.classList.add('rotate-ok');

let toastTimer;
function toast(text, ms = 2500) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ---------- Kütüphane ----------
const songCache = new Map();
let selected = LIBRARY[0];

async function renderLibrary() {
  const lib = $('#library');
  lib.innerHTML = '';
  for (const entry of LIBRARY) {
    const card = document.createElement('button');
    card.className = 'song-card';
    card.innerHTML = `<div class="art"></div><div><h3></h3><p class="muted small"></p><span class="badge">Yükleniyor…</span></div>`;
    card.querySelector('h3').textContent = entry.title;
    card.querySelector('p').textContent = entry.artist;
    card.onclick = () => openSetup(entry);
    lib.appendChild(card);
    const song = await getSong(entry);
    const badge = card.querySelector('.badge');
    badge.textContent = song ? `${song.notes.length} nota · hazır` : 'MIDI dosyası gerekli';
    badge.classList.add(song ? 'ok' : 'no');
  }
}

async function getSong(entry) {
  if (!songCache.has(entry.id)) {
    try { songCache.set(entry.id, await loadSong(entry)); }
    catch (err) { console.error(err); songCache.set(entry.id, null); }
  }
  return songCache.get(entry.id);
}

// ---------- Şarkı ayarları ----------
async function openSetup(entry) {
  selected = entry;
  $('#setup-title').textContent = entry.title;
  $('#setup-artist').textContent = entry.artist;
  go('setup');
  refreshSetup(await getSong(entry));
}

function refreshSetup(song) {
  $('#setup-missing').classList.toggle('hidden', !!song);
  $('#setup-ready').classList.toggle('hidden', !song);
  if (!song) return;
  const r = song.notes.filter((n) => n.hand === 'R').length;
  const l = song.notes.length - r;
  const mins = Math.floor(song.duration / 60), secs = Math.round(song.duration % 60);
  $('#song-info').textContent = `${song.notes.length} nota (sağ el ${r}, sol el ${l}) · ${mins}:${String(secs).padStart(2, '0')} dk`;
  for (const seg of document.querySelectorAll('.seg')) {
    const key = seg.dataset.opt;
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.val === String(settings[key])));
  }
  $('#opt-wait').checked = settings.wait;
}

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings[seg.dataset.opt] = b.dataset.val;
    saveSettings();
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
});
$('#opt-wait').onchange = (e) => { settings.wait = e.target.checked; saveSettings(); };

async function onMidiFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const err = $('#midi-error');
  err.classList.add('hidden');
  try {
    const song = await importSongFile(selected, file);
    songCache.set(selected.id, song);
    refreshSetup(song);
    toast(`Yüklendi: ${song.notes.length} nota`);
  } catch (ex) {
    err.textContent = ex.message || 'Dosya okunamadı.';
    err.classList.remove('hidden');
  }
}
$('#midi-file').onchange = onMidiFile;
$('#midi-file-2').onchange = onMidiFile;

// ---------- Oyun ----------
const stage = $('#stage');
const renderer = new Renderer(stage, $('#stage-canvas'), $('#stage-spacer'));
let game = null;
let raf = 0;
let lastT = 0;
let countdownUntil = 0;
let userScrolledAt = 0;

$('#start-btn').onclick = async () => {
  const song = await getSong(selected);
  if (!song) return;
  await ensureMic(); // tıklama sırasında izin iste (iOS gereği)
  startGame(song);
};

function startGame(song) {
  game = new Game(song, {
    hands: settings.hands,
    speed: Number(settings.speed),
    wait: settings.wait,
    octaveTolerant: settings.octaveTolerant,
  });
  go('play');
  $('#paused').classList.add('hidden');
  requestAnimationFrame(() => {
    renderer.resize();
    const first = game.required[0] || game.notes[0];
    if (first) renderer.centerOn(first.midi);
    countdownUntil = performance.now() + 3000;
    lastT = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  });
}

function stopGame() {
  cancelAnimationFrame(raf);
  game = null;
}

function frame(t) {
  if (!game) return;
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;

  const cd = $('#countdown');
  if (t < countdownUntil) {
    cd.classList.remove('hidden');
    cd.querySelector('.count').textContent = Math.ceil((countdownUntil - t) / 1000);
  } else {
    cd.classList.add('hidden');
    game.update(dt);
  }

  const expected = game.expectedNotes();
  const expectedHand = new Map(expected.map((n) => [n.midi, n.hand]));
  // Sıradaki notalar ekran dışındaysa klavyeyi kaydır (kullanıcı elle kaydırmadıysa)
  if (performance.now() - userScrolledAt > 2500) {
    const upcoming = game.required.filter((n) => n.state === 'pending' && n.time < game.songTime + 1.5).slice(0, 4);
    renderer.ensureVisible((upcoming.length ? upcoming : expected).map((n) => n.midi));
  }
  renderer.draw({ notes: game.notes, songTime: game.songTime, expectedHand, waiting: game.waiting });

  $('#progress-fill').style.width = (game.progress * 100).toFixed(1) + '%';
  $('#play-hint').textContent = game.waiting ? 'Bekliyor: ' + expected.map((n) => midiToName(n.midi)).join(' ') : '';

  if (game.finished) return showResults();
  raf = requestAnimationFrame(frame);
}

function showResults() {
  const r = game.results();
  $('#r-acc').textContent = r.accuracy + '%';
  $('#r-rhythm').textContent = r.rhythm + '%';
  $('#r-time').textContent = `${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, '0')}`;
  $('#r-detail').textContent = `${r.total} notanın ${r.hit} tanesi doğru · ${r.wrong} yanlış tuş` + (r.missed ? ` · ${r.missed} kaçırılan` : '');
  go('results');
}
$('#again-btn').onclick = () => getSong(selected).then((s) => s && startGame(s));

$('#play-back').onclick = () => go('setup');
$('#pause-btn').onclick = () => { if (game) { game.paused = true; $('#paused').classList.remove('hidden'); } };
$('#resume-btn').onclick = () => { if (game) { game.paused = false; lastT = performance.now(); $('#paused').classList.add('hidden'); } };
$('#restart-btn').onclick = () => game && startGame(game.song);
// Kullanıcı klavyeyi elle kaydırırsa otomatik takip bir süre beklesin
for (const ev of ['touchmove', 'wheel']) {
  stage.addEventListener(ev, () => { userScrolledAt = performance.now(); }, { passive: true });
}

window.addEventListener('resize', () => {
  setTimeout(() => {
    if (current === 'play') renderer.resize();
    if (current === 'tuner') tunerRenderer.resize();
  }, 100);
});

// ---------- Giriş olaylarını oyuna ve ekrana bağla ----------
const lastNotes = [];
input.on('noteon', ({ midi, source }) => {
  let kind = 'neutral';
  if (game && current === 'play') {
    const res = game.noteOn(midi);
    kind = res === 'correct' ? 'correct' : res === 'wrong' ? 'wrong' : 'neutral';
  }
  const r = current === 'tuner' ? tunerRenderer : renderer;
  r.held.set(midi, kind);
  r.flash(midi, kind, 500);
  // Mikrofon "bırakma"yı geç algılayabildiği için tutma rengini kısa tut
  if (source !== 'midi') setTimeout(() => { if (r.held.get(midi) === kind) r.held.delete(midi); }, 350);
  lastNotes.unshift(midiToName(midi));
  lastNotes.length = Math.min(lastNotes.length, 8);
  if (current === 'tuner') $('#t-last').textContent = 'Son algılanan tuşlar: ' + lastNotes.join('  ');
});
input.on('noteoff', ({ midi }) => {
  renderer.held.delete(midi);
  tunerRenderer.held.delete(midi);
});
input.on('level', ({ rms, gate }) => {
  const pct = Math.min(100, Math.sqrt(rms / 0.3) * 100);
  if (current === 'play') {
    const el = $('#play-level');
    el.style.width = pct + '%';
    el.style.background = rms > gate ? 'var(--good)' : 'var(--muted)';
  } else if (current === 'tuner') {
    $('#t-level').style.width = pct + '%';
    $('#t-level').style.background = rms > gate ? 'var(--good)' : 'var(--muted)';
    $('#t-gate').style.left = Math.min(100, Math.sqrt(gate / 0.3) * 100) + '%';
  }
});

// Ekran klavyesine dokunma (kaydırmadan ayırmak için kısa dokunuşları sayıyoruz)
function bindTouchKeyboard(el, getRenderer) {
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    const rect = el.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, rx: e.clientX - rect.left, ry: e.clientY - rect.top };
  });
  el.addEventListener('pointerup', (e) => {
    if (!start) return;
    const moved = Math.abs(e.clientX - start.x) + Math.abs(el.scrollLeft - start.sl);
    const m = moved < 10 ? getRenderer().keyAt(start.rx, start.ry) : null;
    start = null;
    if (m !== null) {
      touch.press(m);
      setTimeout(() => touch.release(m), 200);
    }
  });
  el.addEventListener('pointercancel', () => { start = null; });
}
bindTouchKeyboard(stage, () => renderer);

// Bilgisayar klavyesiyle deneme: A S D F G H J K = C4..C5 beyaz tuşlar, W E T Y U = siyahlar
const KEYMAP = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72 };
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  const m = KEYMAP[e.key.toLowerCase()];
  if (m !== undefined) touch.press(m);
});
window.addEventListener('keyup', (e) => {
  const m = KEYMAP[e.key.toLowerCase()];
  if (m !== undefined) touch.release(m);
});

// ---------- Akort testi ----------
const tunerStage = $('#tuner-stage');
const tunerRenderer = new Renderer(tunerStage, $('#tuner-canvas'), $('#tuner-spacer'));
bindTouchKeyboard(tunerStage, () => tunerRenderer);
let tunerRaf = 0;
let lastPitchAt = 0;

function enterTuner() {
  syncSensitivity();
  $('#tuner-mic').classList.toggle('hidden', mic.running);
  requestAnimationFrame(() => {
    tunerRenderer.resize();
    tunerRenderer.centerOn(60);
    cancelAnimationFrame(tunerRaf);
    const loop = () => {
      if (current !== 'tuner') return;
      tunerRenderer.draw({});
      if (performance.now() - lastPitchAt > 600) {
        $('#t-note').classList.remove('good');
      }
      tunerRaf = requestAnimationFrame(loop);
    };
    loop();
  });
}
$('#tuner-mic').onclick = async () => {
  if (await ensureMic()) $('#tuner-mic').classList.add('hidden');
};
input.on('pitch', ({ freq, midi, cents }) => {
  if (current !== 'tuner') return;
  lastPitchAt = performance.now();
  const inRange = midi >= LOW_MIDI && midi <= HIGH_MIDI;
  $('#t-note').textContent = midiToName(midi);
  $('#t-note').classList.toggle('good', inRange && Math.abs(cents) < 15);
  $('#t-freq').textContent = freq.toFixed(1) + ' Hz  ·  ' + (cents > 0 ? '+' : '') + cents + ' sent';
  $('#t-needle').style.left = `calc(${50 + Math.max(-50, Math.min(50, cents))}% - 2px)`;
});

// ---------- Ayarlar ekranı ----------
function syncSensitivity() {
  for (const id of ['t-sens', 's-sens']) $('#' + id).value = settings.sensitivity;
  $('#t-sens-val').textContent = $('#s-sens-val').textContent = settings.sensitivity;
}
function onSens(e) {
  settings.sensitivity = Number(e.target.value);
  mic.setSensitivity(settings.sensitivity);
  saveSettings();
  syncSensitivity();
}
$('#t-sens').oninput = onSens;
$('#s-sens').oninput = onSens;

function enterSettings() {
  syncSensitivity();
  $('#s-octave').checked = settings.octaveTolerant;
  if (!MidiInput.supported) {
    $('#s-midi').disabled = true;
    $('#s-midi-status').textContent = 'Bu tarayıcı Web MIDI desteklemiyor (iPhone Safari desteklemez). Kod hazır; destekleyen tarayıcıda çalışır.';
  }
}
$('#s-octave').onchange = (e) => { settings.octaveTolerant = e.target.checked; saveSettings(); };
$('#s-midi').onclick = async () => {
  try {
    const names = await midiIn.start();
    $('#s-midi-status').textContent = names.length ? 'Bağlı: ' + names.join(', ') : 'Erişim var ama bağlı cihaz yok.';
  } catch (err) {
    $('#s-midi-status').textContent = err.message;
  }
};

// ---------- Başlat ----------
renderLibrary();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Test kolaylığı için konsoldan erişim
window.piano = { input, mic, settings, get game() { return game; } };
