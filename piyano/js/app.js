// Uygulama: ekranlar, ayarlar ve oyun döngüsü
import { InputManager } from './input/InputManager.js';
import { MicInput } from './input/MicInput.js';
import { SimpleMicInput } from './input/SimpleMicInput.js';
import { MidiInput } from './input/MidiInput.js';
import { TouchInput } from './input/TouchInput.js';
import { LIBRARY, loadSong, importSongFile } from './song.js';
import { Game } from './game.js';
import { PianoSound } from './sound.js';
import { Renderer, COLORS } from './renderer.js';
import { noteLabelOct as midiToName, setLabelStyle, LOW_MIDI, HIGH_MIDI } from './notes.js';

const $ = (sel) => document.querySelector(sel);

// ---------- Ayarlar (cihazda saklanır) ----------
const DEFAULTS = { sensitivity: 70, octaveTolerant: false, hands: 'R', speed: '0.75', wait: true, labels: 'letter', barLabels: true, metro: false };
const settings = { ...DEFAULTS, ...readJSON('piano.settings') };
// v2: yeni algılayıcı için varsayılan hassasiyet 60 -> 70
if (!settings.v2) { if (settings.sensitivity === 60) settings.sensitivity = 70; settings.v2 = true; }
setLabelStyle(settings.labels);
function saveSettings() {
  try { localStorage.setItem('piano.settings', JSON.stringify(settings)); } catch { /* yok say */ }
}
function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}

// ---------- Giriş katmanı ----------
const input = new InputManager();
// İki algılama yöntemi; ayarlardan seçilir. Dışarıya tek bir "mic" kaynağı gibi görünür.
class SwitchableMic {
  constructor() {
    this.impls = { advanced: new MicInput(), simple: new SimpleMicInput() };
    this.mode = 'advanced';
    this.onEvent = () => {};
    for (const impl of Object.values(this.impls)) impl.onEvent = (t, d) => this.onEvent(t, d);
  }
  get current() { return this.impls[this.mode]; }
  get running() { return this.current.running; }
  setSensitivity(v) { for (const impl of Object.values(this.impls)) impl.setSensitivity(v); }
  setHints(midis) { this.current.setHints?.(midis); }
  start() { return this.current.start(); }
  stop() { this.current.stop(); }
  async setMode(mode) {
    if (mode === this.mode || !this.impls[mode]) return;
    const wasRunning = this.running;
    if (wasRunning) this.current.stop();
    this.mode = mode;
    if (wasRunning) await this.current.start();
  }
}
const mic = input.add('mic', new SwitchableMic());
mic.mode = settings.detector === 'simple' ? 'simple' : 'advanced';
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
  const bests = readJSON('piano.best');
  for (const entry of LIBRARY) {
    const card = document.createElement('button');
    card.className = 'song-card';
    card.innerHTML = `<div class="art"></div><div><h3></h3><p class="muted small"></p><span class="badge">Yükleniyor…</span><span class="stars-mini"></span></div><span class="play-ic">▶</span>`;
    card.querySelector('h3').textContent = entry.title;
    card.querySelector('p').textContent = entry.artist;
    card.onclick = () => openSetup(entry);
    lib.appendChild(card);
    const best = bests[entry.id];
    if (best) card.querySelector('.stars-mini').textContent = '★'.repeat(best.stars) + '☆'.repeat(3 - best.stars);
    const song = await getSong(entry);
    const badge = card.querySelector('.badge');
    badge.textContent = song ? `${song.notes.length} nota · hazır` : 'MIDI dosyası gerekli';
    badge.classList.add(song ? 'ok' : 'no');
  }
}
$('#hero-start').onclick = () => openSetup(LIBRARY[0]);
$('#midi-file-home').onchange = async (e) => {
  selected = LIBRARY[0];
  await openSetup(selected);
  await onMidiFile(e);
};

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
  $('#opt-metro').checked = settings.metro;
  const best = readJSON('piano.best')[song.id];
  $('#song-best').textContent = best ? `En iyi skorun: %${best.accuracy} doğruluk · ${'★'.repeat(best.stars)}${'☆'.repeat(3 - best.stars)}` : '';
}

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings[seg.dataset.opt] = b.dataset.val;
    saveSettings();
    if (seg.dataset.opt === 'labels') setLabelStyle(b.dataset.val);
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  });
});
$('#opt-wait').onchange = (e) => { settings.wait = e.target.checked; saveSettings(); };
$('#opt-metro').onchange = (e) => { settings.metro = e.target.checked; saveSettings(); };

// ---------- Metronom ----------
let audioCtx = null;
let lastClickAt = 0;
function ensureAudio() {
  try {
    audioCtx = piano.ensure();
  } catch { audioCtx = null; }
}
function click(accent) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.frequency.value = accent ? 1760 : 1320;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.06);
  lastClickAt = performance.now();
}
// Dokunulan notanın piyano sesi (gerçek piyano kayıtları)
const piano = new PianoSound();
let lastToneAt = 0;
function playTone(midi, opts) {
  piano.play(midi, opts);
  lastToneAt = performance.now();
}

// Bir vuruşun süresi (şarkı sn); çok hızlı/yavaş tempoları makul aralığa çek
function beatSec() {
  let b = 60 / (game.song.bpm || 120);
  while (b < 0.3) b *= 2;
  while (b > 1.3) b /= 2;
  return b;
}

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
let countdownStart = 0;
let countIn = null; // metronom açıksa başlamadan 4 vuruş say
let lastBeat = null;
let userScrolledAt = 0;

$('#start-btn').onclick = async () => {
  const song = await getSong(selected);
  if (!song) return;
  await ensureMic(); // tıklama sırasında izin iste (iOS gereği)
  startGame(song);
};
// Dinle: şarkıyı uygulama kendisi çalar, tuşlar kendiliğinden yanar
$('#listen-btn').onclick = async () => {
  const song = await getSong(selected);
  if (!song) return;
  ensureAudio();
  startGame(song, { listen: true });
};

let listenIdx = 0;
function startGame(song, mode = {}) {
  if (settings.metro || mode.listen) ensureAudio();
  listenIdx = 0;
  game = new Game(song, {
    listen: !!mode.listen,
    hands: settings.hands,
    speed: Number(settings.speed),
    wait: settings.wait,
    octaveTolerant: settings.octaveTolerant,
  });
  go('play');
  $('#sequence').classList.toggle('hidden', !!mode.listen);
  seqKey = '';
  loopA = null; shownLoops = 0;
  renderer.showBarLabels = settings.barLabels;
  setLoopUI();
  updateStreak();
  $('#paused').classList.add('hidden');
  requestAnimationFrame(() => {
    const ms = song.notes.map((n) => n.midi);
    if (ms.length) renderer.setRange(Math.min(...ms), Math.max(...ms));
    else renderer.resize();
    renderer.scroller.scrollLeft = 0;
    const first = game.required[0] || game.notes[0];
    if (first) renderer.centerOn(first.midi);
    countIn = settings.metro ? { beat: beatSec() / game.opts.speed * 1000, done: 0 } : null;
    countdownUntil = performance.now() + (countIn ? countIn.beat * 4 : 3000);
    countdownStart = performance.now();
    lastBeat = null;
    lastT = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  });
}

// Dinleme modunda çizgiye gelen notaları çal ve tuşlarını yak
function autoPlay() {
  const notes = game.notes;
  if (game.seeked) {
    game.seeked = false;
    listenIdx = notes.findIndex((n) => n.time >= game.songTime - 0.01);
    if (listenIdx < 0) listenIdx = notes.length;
  }
  while (listenIdx < notes.length && notes[listenIdx].time <= game.songTime) {
    const n = notes[listenIdx++];
    if (game.songTime - n.time > 0.25) continue; // sarma sonrası eskileri çalma
    const real = n.duration / game.opts.speed;
    playTone(n.midi, { duration: real, volume: 0.8 });
    n.state = 'hit';
    renderer.held.set(n.midi, 'listen');
    renderer.flash(n.midi, 'listen', real * 1000);
    setTimeout(() => { if (renderer.held.get(n.midi) === 'listen') renderer.held.delete(n.midi); }, Math.max(120, real * 1000 - 30));
  }
}

function stopGame() {
  cancelAnimationFrame(raf);
  game = null;
  mic.setHints([]);
}

function frame(t) {
  if (!game) return;
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;

  const cd = $('#countdown');
  if (t < countdownUntil) {
    cd.classList.remove('hidden');
    if (countIn) {
      const k = Math.floor((t - countdownStart) / countIn.beat);
      if (k >= countIn.done) { click(k === 0); countIn.done = k + 1; }
      cd.querySelector('.count').textContent = Math.min(4, k + 1);
    } else {
      cd.querySelector('.count').textContent = Math.ceil((countdownUntil - t) / 1000);
    }
  } else {
    cd.classList.add('hidden');
    game.update(dt);
    if (game.opts.listen) autoPlay();
    if (settings.metro && !game.waiting && !game.paused) {
      const b = beatSec();
      const k = Math.floor((game.songTime - (game.song.beat0 || 0)) / b);
      if (lastBeat !== null && k > lastBeat) click(k % 4 === 0);
      lastBeat = k;
    }
  }

  const expected = game.expectedNotes();
  const expectedHand = new Map(expected.map((n) => [n.midi, n.hand]));
  // Sıradaki notalar ekran dışındaysa klavyeyi kaydır (kullanıcı elle kaydırmadıysa)
  if (performance.now() - userScrolledAt > 2500) {
    const upcoming = game.required.filter((n) => n.state === 'pending' && n.time < game.songTime + 1.5).slice(0, 4);
    renderer.ensureVisible((upcoming.length ? upcoming : expected).map((n) => n.midi));
  }
  const cur = game.currentStep();
  renderSequence(cur);
  // Mikrofona sıradaki adımın notalarını ipucu olarak ver (akor algılamaya yardım eder)
  mic.setHints(cur < game.steps.length ? game.steps[cur].notes.filter((n) => n.state === 'pending').map((n) => n.midi) : []);
  // Sıradaki 6 adımın sıra numarası düşen çubukların üstünde görünsün
  const order = new Map();
  for (let i = cur; i < Math.min(game.steps.length, cur + 6); i++) {
    for (const n of game.steps[i].notes) if (n.state === 'pending') order.set(n.id, i - cur + 1);
  }
  renderer.draw({ notes: game.notes, songTime: game.songTime, expectedHand, waiting: game.waiting, order, bpm: 60 / beatSec(), beat0: game.song.beat0 || 0, loop: loopA === null ? null : { a: loopA, b: game.loop?.b } });
  if (game.loopCount !== shownLoops) { shownLoops = game.loopCount; lastBeat = null; seqKey = ''; userScrolledAt = 0; toast(`Tekrar ${shownLoops}`, 900); }

  $('#progress-fill').style.width = (game.progress * 100).toFixed(1) + '%';
  if (loopA !== null && !game.loop) setLoopUI();
  updateStreak();
  $('#time-label').textContent = fmtTime(game.songTime / game.opts.speed) + ' / ' + fmtTime(game.song.duration / game.opts.speed);
  $('#play-hint').textContent = game.opts.listen ? '🎧 Dinliyorsun' : game.waiting ? 'Bekliyor: ' + expected.map((n) => midiToName(n.midi)).join(' ') : '';

  if (game.finished) {
    if (game.opts.listen) { toast('Dinleme bitti. Şimdi sıra sende!'); go('setup'); return; }
    return showResults();
  }
  raf = requestAnimationFrame(frame);
}

// ---------- Sıradaki notalar şeridi ----------
// Ardışık aynı notalar tek kutuda "E4 ×3" olarak gösterilir; noktalar kaçının çalındığını gösterir.
const seqEl = $('#sequence');
let seqKey = '';
function renderSequence(cur) {
  const steps = game.steps;
  const key = cur + '|' + game.waiting;
  if (key === seqKey) return;
  seqKey = key;
  if (cur >= steps.length) { seqEl.innerHTML = ''; return; }
  const label = (st) => [...st.notes].sort((a, b) => a.midi - b.midi).map((n) => midiToName(n.midi)).join(' + ');
  // Adımları ardışık tekrarlara göre grupla (mevcut adımın biraz gerisinden başla)
  const runs = [];
  let start = cur;
  while (start > 0 && label(steps[start - 1]) === label(steps[cur])) start--;
  for (let i = start; i < steps.length && runs.length < 14; i++) {
    const l = label(steps[i]);
    const last = runs[runs.length - 1];
    if (last && last.label === l) last.steps.push(i);
    else runs.push({ label: l, hand: steps[i].notes[0].hand, steps: [i] });
  }
  seqEl.innerHTML = '';
  if (!runs.length) return;
  runs.forEach((run, ri) => {
    const el = document.createElement('div');
    const isCur = run.steps.includes(cur);
    el.className = 'seq-item ' + (run.hand === 'L' ? 'left' : 'right') + (isCur ? ' current' : '') + (isCur && game.waiting ? ' waiting' : '');
    const name = document.createElement('span');
    name.className = 'seq-name';
    name.textContent = run.label;
    el.appendChild(name);
    if (run.steps.length > 1) {
      const times = document.createElement('span');
      times.className = 'seq-times';
      times.textContent = '×' + run.steps.length;
      el.appendChild(times);
      const dots = document.createElement('span');
      dots.className = 'seq-dots';
      dots.textContent = run.steps.map((i) => (i < cur ? '●' : '○')).join('');
      el.appendChild(dots);
    }
    seqEl.appendChild(el);
    if (ri < runs.length - 1) {
      const arrow = document.createElement('span');
      arrow.className = 'seq-arrow';
      arrow.textContent = '›';
      seqEl.appendChild(arrow);
    }
  });
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function showResults() {
  const r = game.results();
  const stars = r.accuracy >= 90 ? 3 : r.accuracy >= 70 ? 2 : r.accuracy >= 40 ? 1 : 0;
  $('#r-stars').innerHTML = [0, 1, 2].map((i) => `<span class="${i < stars ? '' : 'off'}">⭐</span>`).join('');
  const bests = readJSON('piano.best');
  const prev = bests[selected.id];
  if (!prev || r.accuracy > prev.accuracy) {
    bests[selected.id] = { accuracy: r.accuracy, stars, at: Date.now() };
    try { localStorage.setItem('piano.best', JSON.stringify(bests)); } catch { /* yok say */ }
  }
  $('#r-best').textContent = !prev ? '' : r.accuracy > prev.accuracy ? `Yeni rekor! Önceki en iyi: %${prev.accuracy}` : `En iyi skorun: %${prev.accuracy}`;
  $('#r-acc').textContent = r.accuracy + '%';
  $('#r-rhythm').textContent = r.rhythm + '%';
  $('#r-time').textContent = `${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, '0')}`;
  $('#r-detail').textContent = `${r.total} notanın ${r.hit} tanesi doğru · ${r.wrong} yanlış tuş`
    + (r.missed ? ` · ${r.missed} kaçırılan` : '') + (r.maxStreak > 1 ? ` · en uzun seri ${r.maxStreak}` : '');
  go('results');
}
$('#again-btn').onclick = () => getSong(selected).then((s) => s && startGame(s));

$('#play-back').onclick = () => go('setup');

// ---------- İleri / geri sarma ----------
function seekBy(sec) {
  if (!game) return;
  game.seek(game.songTime + sec * game.opts.speed);
  seqKey = '';
  userScrolledAt = 0;
  lastBeat = null;
}

// ---------- Bölüm tekrarı (A–B) ----------
// 1. dokunuş: A = şu an, 2. dokunuş: B = şu an (A'ya geri döner ve tekrarlar), 3. dokunuş: kapat
let loopA = null;
let shownLoops = 0;
const loopBtn = $('#loop-btn');
function setLoopUI() {
  const reg = $('#loop-region');
  loopBtn.classList.toggle('armed', loopA !== null && !game?.loop);
  loopBtn.classList.toggle('on', !!game?.loop);
  loopBtn.textContent = game?.loop ? '🔁 A–B' : loopA !== null ? 'A–?' : 'A–B';
  reg.classList.toggle('hidden', loopA === null || !game);
  if (game && loopA !== null) {
    const d = game.song.duration;
    const b = game.loop ? game.loop.b : game.songTime;
    reg.style.left = (loopA / d * 100) + '%';
    reg.style.width = Math.max(0.5, (b - loopA) / d * 100) + '%';
  }
}
loopBtn.onclick = () => {
  if (!game) return;
  if (loopA === null) {
    loopA = Math.max(0, game.songTime - 0.3);
    toast('A noktası işaretlendi. Bölümün sonunda tekrar dokun.');
  } else if (!game.loop) {
    const b = game.songTime + 0.2;
    if (b - loopA < 1) { toast('Bölüm çok kısa, biraz daha ilerle.'); return; }
    game.loop = { a: loopA, b };
    game.seek(loopA);
    seqKey = ''; userScrolledAt = 0; lastBeat = null;
    toast('Bu bölüm tekrar edecek. Kapatmak için tekrar dokun.');
  } else {
    game.loop = null;
    loopA = null;
    toast('Bölüm tekrarı kapandı.');
  }
  setLoopUI();
};
$('#rew-btn').onclick = () => seekBy(-5);
$('#fwd-btn').onclick = () => seekBy(5);
// İlerleme çubuğuna dokun/sürükle: o noktaya git
const progressEl = document.querySelector('.progress');
let seekingBar = false;
function seekToPointer(e) {
  if (!game) return;
  const r = progressEl.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  game.seek(frac * game.song.duration);
  seqKey = '';
  userScrolledAt = 0;
  lastBeat = null;
}
progressEl.addEventListener('pointerdown', (e) => { seekingBar = true; progressEl.setPointerCapture(e.pointerId); seekToPointer(e); });
progressEl.addEventListener('pointermove', (e) => { if (seekingBar) seekToPointer(e); });
progressEl.addEventListener('pointerup', () => { seekingBar = false; });
progressEl.addEventListener('pointercancel', () => { seekingBar = false; });
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
let streakShown = -1;
function updateStreak() {
  const n = game ? game.streak : 0;
  if (n === streakShown) return;
  const el = $('#streak');
  el.classList.toggle('hidden', n < 3);
  el.textContent = '🔥 ' + n;
  if (n > streakShown && n >= 3) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  streakShown = n;
}
input.on('noteon', ({ midi, source, chordPart }) => {
  // Metronom tıkını mikrofon nota sanmasın
  if (source === 'mic' && performance.now() - lastClickAt < 120) return;
  // Telefondan çalan dokunma sesini de mikrofon piyano sanmasın
  if (source === 'mic' && performance.now() - lastToneAt < 900) return;
  if (source === 'mic' && game?.opts.listen) return;
  let kind = 'neutral';
  if (game && current === 'play' && !game.opts.listen) {
    const res = game.noteOn(midi, !!chordPart);
    kind = res === 'correct' ? 'correct' : res === 'wrong' ? 'wrong' : 'neutral';
    const j = game.lastJudge;
    if (kind === 'correct') renderer.burst(midi, COLORS.hit);
    if (j && performance.now() - j.at < 50 && kind !== 'neutral') {
      renderer.popup(j.midi, j.label, j.kind === 'wrong' ? COLORS.wrong : j.label === 'Harika!' ? '#ffd65a' : COLORS.hit);
    }
    updateStreak();
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
    const r = getRenderer();
    const m = moved < 10 ? r.keyAt(start.rx, start.ry) : null;
    // Düşen notaya dokunma: sadece sesini dinlet (skora sayılmaz)
    if (m === null && moved < 10 && el === stage && game) {
      const n = r.noteAt(start.rx, start.ry, game.notes, game.songTime);
      if (n) { playTone(n.midi); r.flash(n.midi, 'neutral', 400); }
    }
    start = null;
    if (m !== null) {
      playTone(m);
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
  $('#s-barlabels').checked = settings.barLabels;
  document.querySelectorAll('[data-opt="labels"] button').forEach((b) => b.classList.toggle('on', b.dataset.val === settings.labels));
  document.querySelectorAll('[data-opt="detector"] button').forEach((b) => b.classList.toggle('on', b.dataset.val === (settings.detector || 'advanced')));
  if (!MidiInput.supported) {
    $('#s-midi').disabled = true;
    $('#s-midi-status').textContent = 'Bu tarayıcı Web MIDI desteklemiyor (iPhone Safari desteklemez). Kod hazır; destekleyen tarayıcıda çalışır.';
  }
}
$('#s-octave').onchange = (e) => { settings.octaveTolerant = e.target.checked; saveSettings(); };
$('#s-barlabels').onchange = (e) => { settings.barLabels = e.target.checked; saveSettings(); };
document.querySelector('[data-opt="detector"]').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) mic.setMode(b.dataset.val).catch((err) => toast(err.message));
});
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
window.piano = { input, mic, touch, renderer, settings, get game() { return game; } };
