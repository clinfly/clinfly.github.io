// Basit mikrofon giriş kaynağı (ilk sürüm): sadece YIN perde algılama.
// Sessiz odada, pedalsız, tek tek basılan notalarda iyi çalışır.
// Ayarlar > Algılama yöntemi > Basit ile seçilir.

import { createYin } from './yin.js';
import { freqToMidiFloat, LOW_MIDI, HIGH_MIDI } from '../notes.js';

const STABLE_FRAMES = 2;      // aynı nota kaç kare üst üste görülmeli
const SWITCH_FRAMES = 6;      // atak (vuruş) görülmeden başka notaya geçmek için gereken kare
const MIN_CLARITY = 0.82;     // YIN güvenilirlik eşiği
const ONSET_RATIO = 1.5;      // enerji ani artış oranı (yeni tuş vuruşu)
const ONSET_WINDOW_MS = 250;
const REFRACTORY_MS = 150;   // bir nota algılandıktan sonra yeni vuruş için bekleme

export class SimpleMicInput {
  constructor() {
    this.onEvent = () => {};
    this.running = false;
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
    hp.frequency.value = 80;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(hp).connect(this.analyser);

    this.buf = new Float32Array(this.analyser.fftSize);
    this.detect = createYin(this.ctx.sampleRate);
    this.resetState();
    this.running = true;
    this.loop();
  }

  resetState() {
    this.active = null;       // şu an basılı kabul edilen nota
    this.candidate = null;
    this.count = 0;
    this.quiet = 0;
    this.recentRms = [];
    this.armedAt = -Infinity;
    this.lastOnAt = -Infinity;
  }

  loop = () => {
    if (!this.running) return;
    this.process(performance.now());
    this.raf = requestAnimationFrame(this.loop);
  };

  process(now) {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    this.onEvent('level', { rms, gate: this.gate });

    // Atak algılama: son karelerin en düşüğüne göre ani enerji artışı
    const minRecent = this.recentRms.length ? Math.min(...this.recentRms) : 0;
    this.recentRms.push(rms);
    if (this.recentRms.length > 5) this.recentRms.shift();
    if (rms > this.gate && rms > minRecent * ONSET_RATIO && now - this.lastOnAt > REFRACTORY_MS) {
      if (now - this.armedAt > 60) this.count = 0; // yeni vuruş: notayı yeniden doğrula
      this.armedAt = now;
    }
    const armed = now - this.armedAt < ONSET_WINDOW_MS;

    if (rms < this.gate) {
      this.candidate = null;
      this.count = 0;
      if (this.active !== null && ++this.quiet > 4) {
        this.onEvent('noteoff', { midi: this.active });
        this.active = null;
      }
      return;
    }
    this.quiet = 0;

    const res = this.detect(this.buf);
    if (!res || res.clarity < MIN_CLARITY) return;
    const midiF = freqToMidiFloat(res.freq);
    const midi = Math.round(midiF);
    const cents = Math.round((midiF - midi) * 100);
    this.onEvent('pitch', { freq: res.freq, midi, cents, clarity: res.clarity, rms });
    if (midi < LOW_MIDI - 12 || midi > HIGH_MIDI + 12) return;

    if (midi === this.candidate) this.count++;
    else { this.candidate = midi; this.count = 1; }

    const isNew = midi !== this.active;
    const ready = armed ? this.count >= STABLE_FRAMES : (isNew && this.count >= SWITCH_FRAMES);
    if (ready && (isNew || armed)) {
      if (this.active !== null) this.onEvent('noteoff', { midi: this.active });
      this.active = midi;
      this.armedAt = -Infinity; // bu vuruş tüketildi
      this.lastOnAt = now;
      this.onEvent('noteon', { midi, velocity: Math.min(1, rms * 10), freq: res.freq });
    }
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
