// Mikrofon giriş kaynağı: getUserMedia + Web Audio.
// Akustik piyanodan nota algılar ve 'noteon' / 'noteoff' olayları üretir.
//
// Nasıl çalışır:
// 1) Vuruş (onset) algılama: her karede spektrumdaki ANİ ARTIŞA bakılır (spectral flux).
//    Önceki nota hâlâ çınlarken bile yeni basılan tuş yakalanır.
// 2) Nota bulma: vuruştan sonraki birkaç karede biriken "yeni enerji" spektrumunda,
//    her aday nota için harmonikleri (f, 2f, 3f...) toplanır; en yüksek puanlı nota seçilir.
//    Böylece hâlâ çınlayan eski nota yeni notayla karışmaz.
// 3) Oktav düzeltme: piyanonun bas notalarında temel frekans zayıf olabilir; 1.5f gibi
//    "ara" harmoniklere bakılarak bir oktav yukarı/aşağı hatası düzeltilir.
// 4) Akor: ilk notanın harmonikleri çıkarılıp kalan enerjide başka notalar aranır.
// YIN (yin.js) ise akort ekranındaki sürekli frekans gösterimi için kullanılır.

import { createYin } from './yin.js';
import { freqToMidiFloat, midiToFreq, LOW_MIDI, HIGH_MIDI } from '../notes.js';

const FFT_SIZE = 8192;          // ~5.9 Hz çözünürlük (48 kHz'de)
const HISTORY = 3;              // flux için karşılaştırılan önceki kare sayısı
const COLLECT_FRAMES = 4;       // vuruştan sonra kaç kare enerji toplanacak (~65 ms)
const REFRACTORY_MS = 180;      // iki vuruş arası en kısa süre (FFT penceresi ~170 ms)
const ONSET_RATIO = 0.12;       // yeni enerji / mevcut enerji oranı eşiği
const STRONG_ONSET = 0.45;      // ses seviyesi artmasa da kesin vuruş sayılan oran
const DOUBLE_MS = 350;          // bu süre içinde ikinci nota için güçlü vuruş gerekir
const MIN_MIDI = LOW_MIDI - 3;
const MAX_MIDI = HIGH_MIDI + 3;
const WEIGHTS = [1, 0.85, 0.65, 0.5, 0.38, 0.28];

export class MicInput {
  constructor() {
    this.onEvent = () => {};
    this.running = false;
    this.hints = new Set();
    this.setSensitivity(60);
  }

  // 0..100: yüksek = daha hassas (daha sessiz sesleri de dinler)
  setSensitivity(value) {
    this.sensitivity = value;
    this.gate = 0.002 * Math.pow(10, (100 - value) / 50); // 100 -> 0.002, 50 -> 0.02, 0 -> 0.2
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Mikrofon erişimi için HTTPS gerekli (veya tarayıcı desteklemiyor).');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Piyano sesi için tüm "konuşma iyileştirmelerini" kapat
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const src = this.ctx.createMediaStreamSource(this.stream);
    // Hafif yüksek geçiren filtre: oda uğultusunu/titreşimi azaltır
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 70;
    src.connect(hp);

    this.timeAnalyser = this.ctx.createAnalyser();
    this.timeAnalyser.fftSize = 2048;
    this.specAnalyser = this.ctx.createAnalyser();
    this.specAnalyser.fftSize = FFT_SIZE;
    this.specAnalyser.smoothingTimeConstant = 0;
    this.specAnalyser.minDecibels = -110;
    hp.connect(this.timeAnalyser);
    hp.connect(this.specAnalyser);

    this.binHz = this.ctx.sampleRate / FFT_SIZE;
    this.timeBuf = new Float32Array(this.timeAnalyser.fftSize);
    this.dbBuf = new Float32Array(this.specAnalyser.frequencyBinCount);
    this.loBin = Math.floor(60 / this.binHz);
    this.hiBin = Math.min(this.dbBuf.length - 2, Math.ceil(6000 / this.binHz));
    this.history = Array.from({ length: HISTORY }, () => new Float32Array(this.dbBuf.length));
    this.histIdx = 0;
    this.mag = new Float32Array(this.dbBuf.length);
    this.acc = new Float32Array(this.dbBuf.length);
    this.flux = new Float32Array(this.dbBuf.length);
    this.yin = createYin(this.ctx.sampleRate);
    this.resetState();
    this.running = true;
    this.loop();
  }

  resetState() {
    this.active = null;     // şu an basılı kabul edilen nota
    this.collecting = 0;    // vuruştan sonra kalan toplama karesi
    this.lastOnsetAt = -Infinity;
    this.quiet = 0;
    this.frames = 0;
    this.lastYin = null;
    this.lastOnAt = -Infinity;
    this.rmsHist = [];
    this.chord = [];
    this.onsetStrength = 0;
  }

  loop = () => {
    if (!this.running) return;
    this.process(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  process(now) {
    // --- Seviye (RMS) ---
    this.timeAnalyser.getFloatTimeDomainData(this.timeBuf);
    let sum = 0;
    for (let i = 0; i < this.timeBuf.length; i++) sum += this.timeBuf[i] * this.timeBuf[i];
    const rms = Math.sqrt(sum / this.timeBuf.length);
    this.onEvent('level', { rms, gate: this.gate });

    // --- Akort ekranı için sürekli perde (YIN) ---
    if (rms > this.gate) {
      const res = this.yin(this.timeBuf);
      if (res && res.clarity > 0.8) {
        const midiF = freqToMidiFloat(res.freq);
        const midi = Math.round(midiF);
        this.lastYin = { midi, clarity: res.clarity, at: now };
        this.onEvent('pitch', { freq: res.freq, midi, cents: Math.round((midiF - midi) * 100), clarity: res.clarity, rms });
      }
    }

    // --- Spektrum ve "yeni enerji" (flux) ---
    this.specAnalyser.getFloatFrequencyData(this.dbBuf);
    const { mag, acc, flux, loBin, hiBin } = this;
    let fluxSum = 0, prevSum = 0;
    for (let k = loBin; k <= hiBin; k++) {
      const db = this.dbBuf[k];
      const m = db > -110 ? Math.pow(10, db / 20) : 0;
      mag[k] = m;
      let prev = 0;
      for (let h = 0; h < HISTORY; h++) if (this.history[h][k] > prev) prev = this.history[h][k];
      const f = m > prev ? m - prev : 0;
      flux[k] = f;
      fluxSum += f;
      prevSum += prev;
    }
    this.history[this.histIdx].set(mag);
    this.histIdx = (this.histIdx + 1) % HISTORY;
    if (++this.frames <= HISTORY) return; // ilk karelerde geçmiş dolsun

    // --- Vuruş algılama ---
    const ratio = fluxSum / (prevSum + 1e-6);
    const minRms = this.rmsHist.length ? Math.min(...this.rmsHist) : 0;
    this.rmsHist.push(rms);
    if (this.rmsHist.length > 6) this.rmsHist.shift();
    if (this.collecting > 0) {
      for (let k = loBin; k <= hiBin; k++) acc[k] += flux[k];
      if (--this.collecting === 0) this.decide(rms, now);
    } else if (rms > this.gate && now - this.lastOnsetAt > REFRACTORY_MS &&
               ((ratio > ONSET_RATIO && rms > minRms * 1.06) || ratio > STRONG_ONSET)) {
      // Gerçek vuruşta hem spektrum hem toplam ses seviyesi birden artar. Sadece spektrum
      // kıpırdıyorsa (tellerin "vuu-vuu" titreşimi, mikrofon kazancı) vuruş sayılmaz.
      this.lastOnsetAt = now;
      this.onsetStrength = ratio;
      this.collecting = COLLECT_FRAMES;
      acc.set(flux);
    }

    // --- Bırakma (ses kesildi) ---
    if (rms < this.gate * 0.7) {
      if (this.active !== null && ++this.quiet > 5) {
        this.onEvent('noteoff', { midi: this.active });
        this.active = null;
      }
    } else {
      this.quiet = 0;
    }
  }

  // Bir frekans çevresindeki (±yarım ton içindeki) en güçlü yeni enerji
  peak(freq, arr = this.acc) {
    const c = freq / this.binHz;
    const w = Math.max(1, Math.round(c * 0.03)); // ~yarım ton
    const lo = Math.max(this.loBin + 1, Math.round(c) - w);
    const hi = Math.min(this.hiBin - 1, Math.round(c) + w);
    let best = 0, bk = -1;
    for (let k = lo; k <= hi; k++) if (arr[k] > best) { best = arr[k]; bk = k; }
    if (bk < 0) return 0;
    // Gerçek bir tepe mi, yoksa komşu notadan sızan enerji mi? Tepenin tam frekansını bul
    // ve beklenen frekanstan çok uzaksa (komşu yarım tona yakınsa) sayma.
    if (arr[bk - 1] > best || arr[bk + 1] > best) return best * 0.2; // pencerenin kenarında, tepe dışarıda
    const a = arr[bk - 1], b = best, g = arr[bk + 1];
    const d = a - 2 * b + g;
    const kk = d !== 0 ? bk + (0.5 * (a - g)) / d : bk;
    const cents = 1200 * Math.log2((kk * this.binHz) / freq);
    const off = Math.abs(cents);
    if (off > 45) return best * 0.2;
    return off > 30 ? best * 0.6 : best;
  }

  score(midi, arr = this.acc) {
    const f = midiToFreq(midi);
    let s = 0;
    for (let h = 1; h <= WEIGHTS.length; h++) {
      const fh = f * h;
      if (fh > 6000) break;
      s += WEIGHTS[h - 1] * this.peak(fh, arr);
    }
    // Temel frekansta hiç enerji olmayan adaylara ceza (sahte alt oktavları eler)
    const fund = this.peak(f, arr);
    const second = this.peak(f * 2, arr);
    if (fund < 0.03 * second) s *= 0.5;
    return s;
  }

  // Bir notanın harmoniklerini spektrumdan sil (akorda sıradaki notayı bulmak için)
  removeHarmonics(midi, arr) {
    const f = midiToFreq(midi);
    for (let h = 1; h <= 10; h++) {
      const c = (f * h) / this.binHz;
      if (c > this.hiBin) break;
      const w = Math.max(1, Math.round(c * 0.03));
      for (let k = Math.max(this.loBin, Math.round(c) - w); k <= Math.min(this.hiBin, Math.round(c) + w); k++) arr[k] *= 0.15;
    }
  }

  // Akor: ilk notadan sonra kalan enerjide başka notalar ara.
  // Uygulama "beklenen notaları" ipucu olarak verirse, onlar için eşik daha düşük.
  findChordNotes(first, firstScore) {
    const work = this.acc.slice();
    const odd = (m, arr) => { const f = midiToFreq(m); return this.peak(f, arr) + this.peak(f * 3, arr); };
    const picked = [first];
    this.removeHarmonics(first, work);
    for (let round = 0; round < 3; round++) {
      let best = null, bestScore = 0;
      for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
        if (picked.includes(m)) continue;
        const s = this.score(m, work);
        if (s > bestScore) { bestScore = s; best = m; }
      }
      if (best === null) break;
      const hinted = this.hints.has(best);
      if (bestScore < (hinted ? 0.22 : 0.55) * firstScore) break;
      if (odd(best, work) < 0.25 * this.peak(midiToFreq(best) * 2, work)) break; // sadece harmonik kalıntısı
      // Temel frekansı gerçekten duyulmalı (diğer notaların harmoniklerinden "hayalet" nota çıkmasın)
      const fb = midiToFreq(best);
      const fundOk = this.peak(fb, work) >= (hinted ? 0.15 : 0.35) * Math.max(this.peak(fb * 2, work), this.peak(fb * 3, work));
      if (!fundOk) break;
      // Seçilen bir notanın oktavı ancak bekleniyorsa eklenir
      if (!hinted && picked.some((p) => Math.abs(p - best) % 12 === 0)) break;
      picked.push(best);
      this.removeHarmonics(best, work);
    }
    // İpucu olarak beklenen ama bulunamayan notalar: orijinal spektrumda kanıt var mı?
    for (const h of this.hints) {
      if (picked.includes(h) || h < MIN_MIDI || h > MAX_MIDI) continue;
      const f = midiToFreq(h);
      const own = this.peak(f) + this.peak(f * 3);
      if (this.score(h) > 0.25 * firstScore && own > 0.2 * (this.peak(midiToFreq(first)) + this.peak(midiToFreq(first) * 3))) picked.push(h);
    }
    return picked;
  }

  // Uygulama şu an beklenen notaları bildirebilir (akor algılamayı kolaylaştırır)
  setHints(midis) {
    this.hints = new Set(midis);
  }

  decide(rms, now) {
    let best = null, bestScore = 0;
    const scores = new Map();
    for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
      const s = this.score(m);
      scores.set(m, s);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    if (best === null || bestScore <= 0) return;

    // Oktav seçimi: aynı nota adının oktavları arasında, TEK harmonikleri (f, 3f, 5f)
    // belirgin olan EN ALÇAK oktav gerçek notadır. (Üst oktavın harmonikleri alt oktavın
    // çift harmonikleriyle çakışır; tek harmonikler ise sadece gerçek notada bulunur.)
    const odd = (m) => {
      const f = midiToFreq(m);
      return this.peak(f) + this.peak(f * 3) + 0.7 * (f * 5 < 6000 ? this.peak(f * 5) : 0);
    };
    const pc = ((best % 12) + 12) % 12;
    const octaves = [];
    for (let m = pc; m <= MAX_MIDI; m += 12) if (m >= MIN_MIDI) octaves.push([m, odd(m)]);
    const maxOdd = Math.max(...octaves.map(([, o]) => o));
    // Alt oktav seçilecekse kendi temel frekansı da gerçekten duyulmalı
    const pick = octaves.find(([m, o]) => {
      const f = midiToFreq(m);
      return o > 0.25 * maxOdd && this.peak(f) > 0.15 * this.peak(f * 2);
    });
    if (pick) best = pick[0];

    // Temiz tek nota varsa oktavı YIN'e sor (çınlayan eski notayı yok sayarak)
    const y = this.yin(this.timeBuf);
    if (y && y.clarity > 0.88) {
      const ym = Math.round(freqToMidiFloat(y.freq));
      if (ym !== this.active && Math.abs(ym - best) === 12) best = ym;
    }

    if (best < LOW_MIDI - 12 || best > HIGH_MIDI + 12) return;
    // Aynı vuruşun devamı olabilecek çok yakın tekrarları yok say
    if (best === this.active && now - this.lastOnAt < 280) return;
    // Bir tuşa basınca iki nota yanmasın: çok kısa sürede ikinci nota ancak güçlü vuruşla
    if (now - this.lastOnAt < DOUBLE_MS && this.onsetStrength < 0.35) return;
    const notes = this.findChordNotes(best, this.score(best));
    if (this.active !== null) this.onEvent('noteoff', { midi: this.active });
    for (const m of this.chord) if (m !== this.active) this.onEvent('noteoff', { midi: m });
    this.active = best;
    this.chord = notes;
    this.lastOnAt = now;
    notes.forEach((m, i) => {
      this.onEvent('noteon', { midi: m, velocity: Math.min(1, rms * 10), freq: midiToFreq(m), chordPart: i > 0 });
    });
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.stream = this.ctx = null;
    if (this.active !== null) this.onEvent('noteoff', { midi: this.active });
    this.active = null;
  }
}
